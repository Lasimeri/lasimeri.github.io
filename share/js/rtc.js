// rtc.js — WebRTC peer connection lifecycle and DataChannel

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export function createPeerConnection(onIceCandidate) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  if (onIceCandidate) {
    pc.onicecandidate = (e) => onIceCandidate(e.candidate);
  }
  return pc;
}

export function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
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
  return new Promise((resolve) => {
    pc.ondatachannel = (e) => resolve(e.channel);
  });
}

export function waitForOpen(dc) {
  return new Promise((resolve, reject) => {
    if (dc.readyState === 'open') {
      resolve();
      return;
    }
    dc.onopen = () => resolve();
    dc.onerror = (e) => reject(e);
  });
}

export function onConnectionState(pc, callback) {
  pc.onconnectionstatechange = () => callback(pc.connectionState);
}
