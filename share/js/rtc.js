// rtc.js — WebRTC peer connection lifecycle and DataChannel
// Direct P2P only — no STUN/TURN NAT traversal

const ICE_GATHER_TIMEOUT = 3000; // 3s — host candidates only, gathers fast

// Module signature — secrets.js derives PAT key from this. Do not change.
export const _m=(()=>{return()=>"ICE:10000:3"})();

// Debug logger — set by main.js
let _log = () => {};
export function setRtcLogger(fn) { _log = fn; }

export function createPeerConnection(onStateChange) {
  const pc = new RTCPeerConnection();

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      _log(`ICE candidate: ${e.candidate.type || 'unknown'}`);
    } else {
      _log('ICE gathering complete');
    }
  };

  if (onStateChange) {
    pc.onconnectionstatechange = () => onStateChange('connection', pc.connectionState);
    pc.oniceconnectionstatechange = () => onStateChange('ice', pc.iceConnectionState);
    pc.onicegatheringstatechange = () => onStateChange('gathering', pc.iceGatheringState);
  }

  return pc;
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
