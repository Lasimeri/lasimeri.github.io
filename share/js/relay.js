// relay.js — WebSocket relay fallback when WebRTC fails
// Wraps WebSocket to mimic DataChannel API so transfer.js works unchanged

import { unlock, unseal } from './secrets.js?v=13';

const _e=[
['mwDfDra/','LXpU0Qes','8PSl/+b3','qq8LSuDq','tH1wt8Di','dJvrrQd1','RrDxzUJM','LBi4Jyj+','95w='],
['1dIHxV36','2MHm7ZWM','KK5LbeVv','ZfxOPvoJ','e0I3oj3+','WACqrNH8']
];
let _s0=null,_s1=null;

async function _i(){
if(_s0)return;
[_s0,_s1]=await Promise.all(_e.map(a=>unlock(a.join(''))))}

async function getRelayUrl(){
await _i();
const[a,b]=await Promise.all([unseal(_s0),unseal(_s1)]);
return`wss://${a}.${b}.deno.net`}

let _log = () => {};
export function setRelayLogger(fn) { _log = fn; }

// Connect to relay and return a channel that looks like a DataChannel
export async function connectRelay(roomId) {
  const relayBase = await getRelayUrl();
  return new Promise((resolve, reject) => {
    const url = `${relayBase}/${roomId}`;
    _log('Connecting to relay...');
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Relay connection timed out'));
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);
      _log('Relay WebSocket connected');
      // Wrap to match DataChannel interface used by transfer.js
      const channel = wrapWebSocket(ws);
      resolve(channel);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Relay connection failed'));
    };
  });
}

// Wait for the other peer to join the relay room
export function waitForPeer(channel) {
  // The relay just forwards — we don't know when the peer joins.
  // Return immediately; the peer's first message will arrive via onmessage.
  // The caller should set up receivers before calling this.
  _log('Waiting for peer on relay...');
  return Promise.resolve();
}

// Wrap WebSocket to match the DataChannel API surface used by transfer.js:
// - send(data)
// - onmessage = (e) => ...   with e.data
// - binaryType = 'arraybuffer'
// - bufferedAmount
// - bufferedAmountLowThreshold  (polyfilled via polling)
// - onbufferedamountlow         (polyfilled via polling)
// - readyState ('open', 'closed', etc.)
function wrapWebSocket(ws) {
  const channel = {
    _ws: ws,

    get readyState() {
      // Map WebSocket states to DataChannel state strings
      switch (ws.readyState) {
        case WebSocket.OPEN: return 'open';
        case WebSocket.CLOSING: return 'closing';
        case WebSocket.CLOSED: return 'closed';
        default: return 'connecting';
      }
    },

    get bufferedAmount() {
      return ws.bufferedAmount;
    },

    set binaryType(val) {
      ws.binaryType = val;
    },

    get binaryType() {
      return ws.binaryType;
    },

    send(data) {
      ws.send(data);
    },

    close() {
      ws.close();
    },

    // onmessage — forwarded from WebSocket
    set onmessage(fn) {
      ws.onmessage = fn;
    },
    get onmessage() {
      return ws.onmessage;
    },

    // Polyfill bufferedAmountLowThreshold + onbufferedamountlow
    // DataChannel fires this event natively; WebSocket doesn't.
    // Poll bufferedAmount when threshold is set.
    bufferedAmountLowThreshold: 0,
    _lowPollTimer: null,

    set onbufferedamountlow(fn) {
      channel._onbufferedamountlow = fn;
      // Start polling when handler is set
      if (fn && !channel._lowPollTimer) {
        channel._lowPollTimer = setInterval(() => {
          if (ws.bufferedAmount <= channel.bufferedAmountLowThreshold) {
            if (channel._onbufferedamountlow) {
              channel._onbufferedamountlow();
              // One-shot like DataChannel
              clearInterval(channel._lowPollTimer);
              channel._lowPollTimer = null;
            }
          }
        }, 50); // 50ms poll — fast enough for flow control
      }
    },
    get onbufferedamountlow() {
      return channel._onbufferedamountlow || null;
    },

    set onerror(fn) { ws.onerror = fn; },
    get onerror() { return ws.onerror; },

    set onclose(fn) { ws.onclose = fn; },
    get onclose() { return ws.onclose; },

    set onopen(fn) { ws.onopen = fn; },
    get onopen() { return ws.onopen; },
  };

  return channel;
}
