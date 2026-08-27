import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { GameDocument, ReactionEvent } from '../types';

// High-speed STUN servers for WebRTC peer-to-peer NAT traversal
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
  iceCandidatePoolSize: 6,
};

export type P2PMessageType =
  | 'GAME_SYNC'
  | 'DICE_ROLL_START'
  | 'REACTION'
  | 'PING'
  | 'PONG';

export interface P2PMessage {
  type: P2PMessageType;
  senderUid: string;
  timestamp: number;
  payload?: any;
}

export interface P2PSignal {
  id: string;
  fromUid: string;
  toUid: string;
  type: 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE' | 'BYE';
  payload: any;
  createdAt: number;
}

class P2PMeshService {
  private roomId: string | null = null;
  private localUid: string | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private signalUnsub: Unsubscribe | null = null;
  private presenceUnsub: Unsubscribe | null = null;
  private messageListeners: Set<(msg: P2PMessage) => void> = new Set();
  private statusListeners: Set<(connectedPeers: number, avgLatencyMs: number) => void> = new Set();
  private lastPingSent = 0;
  private roundtripLatency = 24; // baseline estimated ms
  private pingInterval: any = null;

  /**
   * Initializes automatic WebRTC P2P Data Mesh for room members
   */
  public async initRoomMesh(roomId: string, localUid: string): Promise<void> {
    if (this.roomId === roomId && this.localUid === localUid) {
      return;
    }

    this.teardown();
    this.roomId = roomId;
    this.localUid = localUid;

    try {
      // 1. Register presence in room's P2P mesh
      const presenceRef = doc(db, 'rooms', roomId, 'p2pPresence', localUid);
      await setDoc(presenceRef, {
        uid: localUid,
        joinedAt: Date.now(),
        lastActive: Date.now(),
      }).catch(() => {});

      // 2. Subscribe to incoming signaling messages
      this.subscribeToSignals();

      // 3. Discover peers in the room
      this.subscribeToPresence();

      // 4. Start periodic lightweight ping to measure peer latency
      this.startPingLoop();
    } catch (err) {
      console.warn('P2P Mesh initialization notice:', err);
    }
  }

  /**
   * Broadcast message to all active peer DataChannels (< 30ms latency)
   */
  public broadcast(type: P2PMessageType, payload?: any): void {
    if (!this.localUid) return;

    const msg: P2PMessage = {
      type,
      senderUid: this.localUid,
      timestamp: Date.now(),
      payload,
    };

    const serialized = JSON.stringify(msg);

    this.dataChannels.forEach((dc, peerUid) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(serialized);
        } catch (e) {
          console.debug(`Failed to send to peer ${peerUid}:`, e);
        }
      }
    });
  }

  /**
   * Listen to incoming P2P messages
   */
  public onMessage(callback: (msg: P2PMessage) => void): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * Listen to connection status changes
   */
  public onStatusChange(callback: (connectedPeers: number, avgLatencyMs: number) => void): () => void {
    this.statusListeners.add(callback);
    // Send immediate initial status
    callback(this.getOpenChannelsCount(), this.roundtripLatency);
    return () => this.statusListeners.delete(callback);
  }

  public getConnectedPeersCount(): number {
    return this.getOpenChannelsCount();
  }

  public getLatency(): number {
    return this.roundtripLatency;
  }

  private notifyStatus() {
    const count = this.getOpenChannelsCount();
    this.statusListeners.forEach((cb) => {
      try {
        cb(count, this.roundtripLatency);
      } catch (_) {}
    });
  }

  private getOpenChannelsCount(): number {
    let openCount = 0;
    this.dataChannels.forEach((dc) => {
      if (dc.readyState === 'open') openCount++;
    });
    return openCount;
  }

  private subscribeToPresence() {
    if (!this.roomId || !this.localUid) return;

    const presenceCol = collection(db, 'rooms', this.roomId, 'p2pPresence');
    this.presenceUnsub = onSnapshot(presenceCol, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        const peerUid = change.doc.id;
        if (!peerUid || peerUid === this.localUid) return;

        if (change.type === 'added') {
          // Lexicographical ordering: lower UID creates the offer
          if (this.localUid! < peerUid && !this.peerConnections.has(peerUid)) {
            await this.createOffer(peerUid);
          }
        } else if (change.type === 'removed') {
          this.closePeer(peerUid);
        }
      });
    });
  }

  private subscribeToSignals() {
    if (!this.roomId || !this.localUid) return;

    const signalsQuery = query(
      collection(db, 'rooms', this.roomId, 'p2pSignals'),
      where('toUid', '==', this.localUid)
    );

    this.signalUnsub = onSnapshot(signalsQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const signal = change.doc.data() as P2PSignal;
          const signalDocRef = change.doc.ref;

          await this.handleIncomingSignal(signal);
          deleteDoc(signalDocRef).catch(() => {});
        }
      });
    });
  }

  private async handleIncomingSignal(signal: P2PSignal) {
    const peerUid = signal.fromUid;
    if (!peerUid || peerUid === this.localUid) return;

    try {
      if (signal.type === 'OFFER') {
        const pc = this.getOrCreatePeerConnection(peerUid);
        await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
        await this.drainPendingCandidates(peerUid, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(peerUid, 'ANSWER', answer);
      } else if (signal.type === 'ANSWER') {
        const pc = this.peerConnections.get(peerUid);
        if (pc && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
          await this.drainPendingCandidates(peerUid, pc);
        }
      } else if (signal.type === 'ICE_CANDIDATE') {
        const pc = this.peerConnections.get(peerUid);
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.payload)).catch(() => {});
        } else {
          const pending = this.pendingCandidates.get(peerUid) || [];
          pending.push(signal.payload);
          this.pendingCandidates.set(peerUid, pending);
        }
      } else if (signal.type === 'BYE') {
        this.closePeer(peerUid);
      }
    } catch (err) {
      console.debug('Error processing P2P signal:', err);
    }
  }

  private async drainPendingCandidates(peerUid: string, pc: RTCPeerConnection) {
    const candidates = this.pendingCandidates.get(peerUid);
    if (!candidates || candidates.length === 0) return;

    for (const cand of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (_) {}
    }
    this.pendingCandidates.delete(peerUid);
  }

  private getOrCreatePeerConnection(peerUid: string): RTCPeerConnection {
    let pc = this.peerConnections.get(peerUid);
    if (pc) return pc;

    pc = new RTCPeerConnection(ICE_SERVERS);

    // Answerer side: listen for incoming DataChannel
    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerUid, event.channel);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && this.roomId && this.localUid) {
        this.sendSignal(peerUid, 'ICE_CANDIDATE', event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'disconnected' || pc?.connectionState === 'failed') {
        this.notifyStatus();
      } else if (pc?.connectionState === 'connected') {
        this.notifyStatus();
      }
    };

    this.peerConnections.set(peerUid, pc);
    return pc;
  }

  private async createOffer(peerUid: string) {
    try {
      const pc = this.getOrCreatePeerConnection(peerUid);

      // Offerer side: create the DataChannel
      const dataChannel = pc.createDataChannel('loodoo_p2p', {
        ordered: true,
      });
      this.setupDataChannel(peerUid, dataChannel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.sendSignal(peerUid, 'OFFER', offer);
    } catch (err) {
      console.debug('Failed to create P2P offer:', err);
    }
  }

  private setupDataChannel(peerUid: string, dataChannel: RTCDataChannel) {
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
      this.dataChannels.set(peerUid, dataChannel);
      this.notifyStatus();
      // Send quick ping to calibrate latency
      try {
        this.lastPingSent = Date.now();
        dataChannel.send(
          JSON.stringify({
            type: 'PING',
            senderUid: this.localUid,
            timestamp: Date.now(),
          })
        );
      } catch (_) {}
    };

    dataChannel.onmessage = (event) => {
      try {
        const msg: P2PMessage = JSON.parse(event.data);
        if (msg.type === 'PING') {
          // Respond immediately with PONG
          if (dataChannel.readyState === 'open') {
            dataChannel.send(
              JSON.stringify({
                type: 'PONG',
                senderUid: this.localUid,
                timestamp: msg.timestamp,
              })
            );
          }
          return;
        }

        if (msg.type === 'PONG') {
          const rtt = Math.max(8, Date.now() - msg.timestamp);
          this.roundtripLatency = Math.round(rtt / 2);
          this.notifyStatus();
          return;
        }

        // Notify message listeners
        this.messageListeners.forEach((listener) => {
          try {
            listener(msg);
          } catch (e) {
            console.debug('Message listener error:', e);
          }
        });
      } catch (err) {
        console.debug('P2P message parse error:', err);
      }
    };

    dataChannel.onclose = () => {
      this.dataChannels.delete(peerUid);
      this.notifyStatus();
    };

    dataChannel.onerror = () => {
      this.dataChannels.delete(peerUid);
      this.notifyStatus();
    };

    this.dataChannels.set(peerUid, dataChannel);
  }

  private async sendSignal(toUid: string, type: P2PSignal['type'], payload: any) {
    if (!this.roomId || !this.localUid) return;
    const signalRef = doc(collection(db, 'rooms', this.roomId, 'p2pSignals'));
    const signal: P2PSignal = {
      id: signalRef.id,
      fromUid: this.localUid,
      toUid,
      type,
      payload,
      createdAt: Date.now(),
    };
    await setDoc(signalRef, signal).catch(() => {});
  }

  private startPingLoop() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.getOpenChannelsCount() > 0) {
        this.lastPingSent = Date.now();
        this.broadcast('PING');
      }
    }, 6000);
  }

  private closePeer(peerUid: string) {
    const dc = this.dataChannels.get(peerUid);
    if (dc) {
      try {
        dc.close();
      } catch (_) {}
      this.dataChannels.delete(peerUid);
    }

    const pc = this.peerConnections.get(peerUid);
    if (pc) {
      try {
        pc.close();
      } catch (_) {}
      this.peerConnections.delete(peerUid);
    }

    this.pendingCandidates.delete(peerUid);
    this.notifyStatus();
  }

  /**
   * Leave room and clean up all connections
   */
  public teardown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.presenceUnsub) {
      this.presenceUnsub();
      this.presenceUnsub = null;
    }

    if (this.signalUnsub) {
      this.signalUnsub();
      this.signalUnsub = null;
    }

    // Remove presence
    if (this.roomId && this.localUid) {
      const presenceRef = doc(db, 'rooms', this.roomId, 'p2pPresence', this.localUid);
      deleteDoc(presenceRef).catch(() => {});
    }

    this.dataChannels.forEach((dc) => {
      try {
        dc.close();
      } catch (_) {}
    });
    this.dataChannels.clear();

    this.peerConnections.forEach((pc) => {
      try {
        pc.close();
      } catch (_) {}
    });
    this.peerConnections.clear();
    this.pendingCandidates.clear();

    this.roomId = null;
    this.localUid = null;
    this.notifyStatus();
  }
}

export const p2pMeshService = new P2PMeshService();
