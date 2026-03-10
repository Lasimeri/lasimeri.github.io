// rtc.js — WebRTC peer connection lifecycle and DataChannel
// Optimized for cross-NAT (symmetric NAT on mobile carriers)

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free TURN relay (freestun.net) — 50 Kbit/s cap, last-resort fallback
  {
    urls: 'turn:freestun.net:3478',
    username: 'free',
    credential: 'free'
  }
];

const ICE_GATHER_TIMEOUT = 10000; // 10s — 3 servers, gathering is fast

// Debug logger — set by main.js
let _log = () => {};
export function setRtcLogger(fn) { _log = fn; }

export function createPeerConnection(onStateChange) {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 4  // pre-allocate candidates for faster gathering
  });

  // Log every ICE candidate type during gathering
  const candidateTypes = { host: 0, srflx: 0, relay: 0 };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const type = e.candidate.type || 'unknown';
      candidateTypes[type] = (candidateTypes[type] || 0) + 1;
      _log(`ICE candidate: ${type} ${e.candidate.protocol || ''} ${e.candidate.address || '(redacted)'}`);
    } else {
      // Gathering done — summarize
      _log(`ICE candidates gathered: host=${candidateTypes.host} srflx=${candidateTypes.srflx} relay=${candidateTypes.relay}`);
      if (candidateTypes.relay === 0) {
        _log('WARNING: No relay candidates — TURN may be unreachable. Cross-NAT will fail.');
      }
    }
  };

  if (onStateChange) {
    pc.onconnectionstatechange = () => onStateChange('connection', pc.connectionState);
    pc.oniceconnectionstatechange = () => onStateChange('ice', pc.iceConnectionState);
    pc.onicegatheringstatechange = () => onStateChange('gathering', pc.iceGatheringState);
  }

  return pc;
}

// After connection: report whether direct or relayed
export async function getConnectionType(pc) {
  try {
    const stats = await pc.getStats();
    for (const [, report] of stats) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        // Find the local candidate
        for (const [, r] of stats) {
          if (r.id === report.localCandidateId) {
            return {
              type: r.candidateType,   // 'host', 'srflx', 'relay'
              protocol: r.protocol,     // 'udp', 'tcp'
              relay: r.candidateType === 'relay'
            };
          }
        }
      }
    }
  } catch (e) {
    _log(`Stats error: ${e.message}`);
  }
  return { type: 'unknown', protocol: 'unknown', relay: false };
}

export function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      _log('ICE gathering timed out — proceeding with partial candidates');
      resolve();
    }, ICE_GATHER_TIMEOUT);

    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}

export async function createOffer(pc) {
  const dc = pc.createDataChannel('filetransfer', {
    ordered: true
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  return { dataChannel: dc, sdp: JSON.stringify(pc.localDescription) };
}

export async function createAnswer(pc, offerSdp) {
  const offer = JSON.parse(offerSdp);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  return JSON.stringify(pc.localDescription);
}

export async function acceptAnswer(pc, answerSdp) {
  const answer = JSON.parse(answerSdp);
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export function onDataChannel(pc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('DataChannel timed out — peer may be unreachable'));
    }, 30000);
    pc.ondatachannel = (e) => {
      clearTimeout(timeout);
      resolve(e.channel);
    };
  });
}

export function waitForOpen(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      reject(new Error('DataChannel open timed out'));
    }, 30000);
    dc.onopen = () => {
      clearTimeout(timeout);
      resolve();
    };
    dc.onerror = (e) => {
      clearTimeout(timeout);
      reject(new Error(`DataChannel error: ${e.error?.message || 'unknown'}`));
    };
  });
}
