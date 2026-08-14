import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  desktopLocalOcrAvailable,
  ocrBackendLabel,
  ocrWordStyle,
  type ImageOcrBackend,
} from '../../apps/web/src/lib/imageOcr';

test('OCR 入口对桌面端开放，本地浏览器不开放（issue #163）', () => {
  assert.equal(desktopLocalOcrAvailable(true), true);
  assert.equal(desktopLocalOcrAvailable(false), false);
});

test('OCR 结果会如实暴露实际后端（issue #163）', () => {
  const labels: Record<ImageOcrBackend, string> = {
    'pp-ocrv5': 'PP-OCRv5 本地离线引擎',
    'windows-media-ocr': 'Windows.Media.Ocr',
  };
  for (const [backend, label] of Object.entries(labels)) {
    assert.equal(ocrBackendLabel(backend as ImageOcrBackend), label);
  }
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

test('默认安装包不下载或捆绑增强 OCR，full 构建必须显式开启', async () => {
  const [configText, buildScript] = await Promise.all([
    readFile('apps/desktop/src-tauri/tauri.conf.json', 'utf8'),
    readFile('apps/desktop/src-tauri/build.rs', 'utf8'),
  ]);
  const config = JSON.parse(configText) as {
    bundle: { resources: Record<string, string> };
  };
  assert.equal(config.bundle.resources['target/ocr-resources/ocr/'], undefined);
  assert.equal(config.bundle.resources['target/codex-resources/codex/'], undefined);
  assert.match(buildScript, /bundle_resource\("ROCKETX_BUNDLE_OCR"\)/);
  assert.doesNotMatch(buildScript, /ROCKETX_BUNDLE_CODEX|prepare_codex_resources/);
});
