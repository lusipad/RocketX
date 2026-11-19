import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeLocalVoiceWav, LOCAL_VOICE_MAX_SECONDS } from '../../apps/web/src/lib/localVoiceAudio';

test('local voice produces bounded 16 kHz mono PCM WAV without clipping', () => {
  const wav = encodeLocalVoiceWav([new Float32Array([0, 2, -2, 0.5])], 16_000);
  const view = new DataView(wav);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});

test('local voice mixes stereo and resamples before handing data to the local recognizer', () => {
  const wav = encodeLocalVoiceWav([new Float32Array(48_000).fill(1), new Float32Array(48_000).fill(-1)], 48_000);
  assert.equal(wav.byteLength, 44 + 16_000 * 2);
  assert.equal(new DataView(wav).getInt16(44, true), 0);
});

test('local voice refuses empty, mismatched, or overlong audio before invoking the host', () => {
  assert.throws(() => encodeLocalVoiceWav([], 16_000), /录音为空/);
  assert.throws(() => encodeLocalVoiceWav([new Float32Array(1), new Float32Array(2)], 16_000), /音轨/);
  assert.throws(() => encodeLocalVoiceWav([new Float32Array(16_000 * (LOCAL_VOICE_MAX_SECONDS + 1))], 16_000), /30 秒/);
});
