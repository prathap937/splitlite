const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function toBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(code) {
  let b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

export function encodeSignal(desc) {
  return toBase64Url(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
}

export function decodeSignal(code) {
  return JSON.parse(fromBase64Url(code));
}

function waitForIceGatheringComplete(pc, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    function check() {
      if (pc.iceGatheringState === 'complete') finish();
    }
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, timeoutMs);
  });
}

// Host side: create a peer connection + data channel, and produce a
// portable "offer code" containing the full local SDP (candidates included,
// since we wait for ICE gathering to finish instead of trickling).
export async function createShareOffer() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('sync');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  return { pc, channel, code: encodeSignal(pc.localDescription) };
}

// Guest side: consume an offer code, produce an answer code. The data
// channel arrives later via the peer connection's 'datachannel' event.
export async function createJoinAnswer(offerCode) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const remoteDesc = decodeSignal(offerCode);
  await pc.setRemoteDescription(remoteDesc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc);
  return { pc, code: encodeSignal(pc.localDescription) };
}

// Host side: apply the guest's answer code to complete the handshake.
export async function completeShare(pc, answerCode) {
  const remoteDesc = decodeSignal(answerCode);
  await pc.setRemoteDescription(remoteDesc);
}
