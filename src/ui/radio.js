import { audioContext } from './sfx.js';
import { AudioTransport } from '../link/audio-transport.js';
import { encodeFrame, decodeFrame } from '../link/frame.js';
import { PING, encodePing, decodePing } from '../link/messages.js';

/**
 * Radio check: send and receive test chirps without playing, so two people can
 * find out whether their devices hear each other.
 */
const $ = (id) => document.getElementById(id);
const EC_KEY = 'battletanks.echoCancellation';
const BAND_NAMES = ['low', 'high'];
const sender = 1 + Math.floor(Math.random() * 255);

let transport = null;
let band = 0;
let counter = 0;
let autoTimer = null;
const counts = { sent: 0, own: 0, other: 0 };

const readEcho = () => { try { return localStorage.getItem(EC_KEY) === '1'; } catch { return false; } };
$('echo').checked = readEcho();
$('echo').addEventListener('change', () => {
  try { localStorage.setItem(EC_KEY, $('echo').checked ? '1' : '0'); } catch { /* private mode */ }
  if (transport) restart();
});

function showCounts() {
  $('count-sent').textContent = counts.sent;
  $('count-own').textContent = counts.own;
  $('count-other').textContent = counts.other;
}

function log(text, kind) {
  const list = $('log');
  if (list.firstElementChild && !list.firstElementChild.className) list.replaceChildren();
  const item = document.createElement('li');
  item.className = kind;
  item.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  list.prepend(item);
  while (list.children.length > 60) list.lastElementChild.remove();
}

function onActivity(activity) {
  if (activity.type !== 'rx') return;
  const frame = decodeFrame(activity.bytes);
  const ping = frame && frame.type === PING ? decodePing(frame.payload) : null;
  const quality = `${Math.round(activity.quality * 100)}%`;
  const level = `${Math.round(20 * Math.log10(activity.level + 1e-9))} dB`;
  const where = `${BAND_NAMES[activity.band]} band, quality ${quality}, level ${level}`;
  if (activity.own || (ping && ping.sender === sender)) {
    counts.own++;
    log(`Heard my own chirp${ping ? ` #${ping.counter}` : ''} (${where})`, 'own');
  } else {
    counts.other++;
    log(ping ? `Chirp #${ping.counter} from device ${ping.sender} (${where})` : `A game chirp from another device (${where})`, 'other');
  }
  showCounts();
}

function send() {
  if (!transport) return;
  counter = (counter + 1) & 0xff;
  counts.sent++;
  showCounts();
  transport.send(encodeFrame(PING, encodePing({ counter, sender })), band);
}

async function start() {
  const reason = AudioTransport.unavailableReason();
  if (reason) { $('mic-status').textContent = reason; return; }
  $('btn-mic').disabled = true;
  $('mic-status').textContent = 'Asking for the microphone…';
  const next = new AudioTransport({ context: audioContext(), echoCancellation: $('echo').checked });
  try {
    await next.start();
  } catch (error) {
    next.stop();
    $('btn-mic').disabled = false;
    $('mic-status').textContent = error?.name === 'NotAllowedError'
      ? 'The microphone was not allowed. Allow it in the browser and try again.'
      : `The microphone could not be started (${error?.message || error}).`;
    return;
  }
  transport = next;
  transport.onActivity = onActivity;
  $('btn-mic').textContent = 'Microphone is on';
  for (const id of ['btn-send', 'btn-auto', 'btn-band']) $(id).disabled = false;
  $('mic-status').textContent = `Listening at ${audioContext().sampleRate} Hz. Echo cancellation is ${$('echo').checked ? 'on' : 'off'}.`;
}

async function restart() {
  transport?.stop();
  transport = null;
  await start();
}

$('btn-mic').addEventListener('click', start);
$('btn-send').addEventListener('click', send);
$('btn-auto').addEventListener('click', () => {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    $('btn-auto').textContent = 'Send every 3 seconds';
  } else {
    send();
    // Not exactly 3 s, so two devices on auto do not keep chirping at the same moment.
    autoTimer = setInterval(send, 2700 + Math.random() * 600);
    $('btn-auto').textContent = 'Stop sending';
  }
});
$('btn-band').addEventListener('click', () => {
  band = 1 - band;
  $('btn-band').textContent = `Sending in the ${BAND_NAMES[band]} band`;
});

setInterval(() => {
  for (const b of [0, 1]) {
    const level = transport ? transport.level(b) : 0;
    const width = Math.max(0, Math.min(1, (20 * Math.log10(level + 1e-6) + 70) / 60));
    $(`meter-${b}`).style.width = `${Math.round(width * 100)}%`;
  }
}, 100);

/**
 * Silent self-test: chirps go from the modulator straight into the demodulator
 * inside the browser's audio engine. Proves the pipeline, not speaker or mic.
 */
export async function selfTest() {
  const result = $('result');
  result.className = '';
  result.textContent = 'Testing…';
  const context = audioContext();
  if (!context) {
    result.className = 'bad';
    result.textContent = 'This browser cannot generate sound.';
    return { sent: 0, received: 0 };
  }
  const loop = new AudioTransport({ context, loopback: true });
  const heard = new Set();
  loop.onActivity = (activity) => {
    if (activity.type !== 'rx') return;
    const frame = decodeFrame(activity.bytes);
    const ping = frame && frame.type === PING ? decodePing(frame.payload) : null;
    if (ping) heard.add(`${activity.band}:${ping.counter}`);
  };
  const total = 6;
  try {
    await loop.start();
    for (let i = 0; i < total; i++) loop.send(encodeFrame(PING, encodePing({ counter: i, sender })), i % 2);
    const deadline = performance.now() + 9000;
    while (heard.size < total && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  } catch (error) {
    result.className = 'bad';
    result.textContent = `The self-test could not run (${error?.message || error}).`;
    loop.stop();
    return { sent: total, received: 0 };
  }
  loop.stop();
  const ok = heard.size === total;
  result.className = ok ? 'good' : 'bad';
  result.textContent = ok
    ? `Passed: ${total} of ${total} test chirps decoded at ${context.sampleRate} Hz. This browser can run the sound link.`
    : `Only ${heard.size} of ${total} test chirps were decoded. The sound link is unlikely to work in this browser.`;
  return { sent: total, received: heard.size };
}

$('btn-self').addEventListener('click', selfTest);
window.radioCheck = { selfTest };
