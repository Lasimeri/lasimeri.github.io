// rtc.js — WebRTC peer connection lifecycle and DataChannel

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free TURN relay (OpenRelay by Metered.ca)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const ICE_GATHER_TIMEOUT = 15000; // 15s max for ICE gathering

export function createPeerConnection(onStateChange) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (onStateChange) {
    pc.onconnectionstatechange = () => onStateChange('connection', pc.connectionState);
    pc.oniceconnectionstatechange = () => onStateChange('ice', pc.iceConnectionState);
    pc.onicegatheringstatechange = () => onStateChange('gathering', pc.iceGatheringState);
  }
  return pc;
}

export function waitForIceGathering(pc) {
  return new Promise((resolve, reject) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      // Resolve with what we have — partial candidates are usable
      console.warn('ICE gathering timed out, proceeding with partial candidates');
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
