import test from 'node:test';
import assert from 'node:assert/strict';
import { isWindowsDesktopOcr, ocrWordStyle } from '../../apps/web/src/lib/imageOcr';

test('OCR 入口只对 Windows 桌面端开放（issue #153）', () => {
  assert.equal(isWindowsDesktopOcr(true, 'Windows NT 10.0'), true);
  assert.equal(isWindowsDesktopOcr(false, 'Windows NT 10.0'), false);
  assert.equal(isWindowsDesktopOcr(true, 'Macintosh'), false);
});

test('OCR 词框按归一化坐标叠加并限制在图片范围内（issue #153）', () => {
  assert.deepEqual(ocrWordStyle({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }), {
    left: '10%',
    top: '20%',
    width: '30%',
    height: '10%',
  });
  assert.deepEqual(ocrWordStyle({ x: -1, y: 0.95, width: 3, height: 2 }), {
    left: '0%',
    top: '95%',
    width: '100%',
    height: '5%',
  });
});
