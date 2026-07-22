use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES: usize = 28 * 1024 * 1024;
const LOCAL_OCR_LANGUAGE: &str = "zh-Hans,en";
const MODEL_VERSION_DIR: &str = "models/ppocrv5-oar-v0.3.0";
const ORT_VERSION_DIR: &str = "onnxruntime/1.23.2";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ImageOcrBackend {
    #[serde(rename = "pp-ocrv5")]
    PpOcrV5,
    #[serde(rename = "windows-media-ocr")]
    WindowsMediaOcr,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOcrWord {
    text: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    space_after: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageOcrResult {
    text: String,
    language: String,
    words: Vec<ImageOcrWord>,
    backend: ImageOcrBackend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalOcrAssets {
    det_model: PathBuf,
    rec_model: PathBuf,
    orientation_model: PathBuf,
    dict_path: PathBuf,
    ort_library: PathBuf,
}

fn normalized_word(
    text: String,
    rect: (f64, f64, f64, f64),
    image: (f64, f64),
    space_after: bool,
) -> ImageOcrWord {
    let (image_width, image_height) = image;
    ImageOcrWord {
        text,
        x: (rect.0 / image_width).clamp(0.0, 1.0),
        y: (rect.1 / image_height).clamp(0.0, 1.0),
        width: (rect.2 / image_width).clamp(0.0, 1.0),
        height: (rect.3 / image_height).clamp(0.0, 1.0),
        space_after,
    }
}

fn has_visual_word_gap(current: (f64, f64, f64, f64), next: (f64, f64, f64, f64)) -> bool {
    let gap = next.0 - (current.0 + current.2);
    // Windows OCR 会把拉丁词和中文逐字拆开。用字高归一化后的真实水平间距
    // 重建空格：紧邻字形合并，明显词间距保留，避免复制出 "Ro c ketX / 本 地"。
    gap > current.3.min(next.3) * 0.35
}

fn decode_image_bytes(encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if encoded.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err("图片过大，OCR 最大支持 20 MB".to_string());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("图片内容无效：{error}"))?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片过大，OCR 最大支持 20 MB".to_string());
    }
    Ok(bytes)
}

fn versioned_model_dir(root: &Path) -> PathBuf {
    root.join(MODEL_VERSION_DIR)
}

fn versioned_runtime_dir(root: &Path) -> PathBuf {
    root.join(ORT_VERSION_DIR).join(ort_runtime_key())
}

fn ort_runtime_key() -> &'static str {
    #[cfg(windows)]
    {
        "windows-x64"
    }
    #[cfg(target_os = "macos")]
    {
        "macos-universal2"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "linux-x64"
    }
}

fn development_resource_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("ocr-resources")
        .join("ocr")
}

fn resource_root_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(value) = std::env::var("ROCKETX_OCR_RESOURCE_ROOT") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            roots.push(PathBuf::from(trimmed));
            return roots;
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("ocr"));
    }
    roots.push(development_resource_root());
    roots
}

fn ort_library_file_name() -> &'static str {
    #[cfg(windows)]
    {
        "onnxruntime.dll"
    }
    #[cfg(target_os = "macos")]
    {
        "libonnxruntime.dylib"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "libonnxruntime.so"
    }
}

fn fallback_backend_for_local_failure(platform_is_windows: bool) -> Option<ImageOcrBackend> {
    if platform_is_windows {
        Some(ImageOcrBackend::WindowsMediaOcr)
    } else {
        None
    }
}

fn resolve_local_assets_from_root(root: &Path) -> Result<LocalOcrAssets, String> {
    let model_dir = versioned_model_dir(root);
    let runtime_dir = versioned_runtime_dir(root);
    let assets = LocalOcrAssets {
        det_model: model_dir.join("pp-ocrv5_mobile_det.onnx"),
        rec_model: model_dir.join("pp-ocrv5_mobile_rec.onnx"),
        orientation_model: model_dir.join("pp-lcnet_x1_0_textline_ori.onnx"),
        dict_path: model_dir.join("ppocrv5_dict.txt"),
        ort_library: runtime_dir.join(ort_library_file_name()),
    };
    let missing = [
        assets.det_model.as_path(),
        assets.rec_model.as_path(),
        assets.orientation_model.as_path(),
        assets.dict_path.as_path(),
        assets.ort_library.as_path(),
    ]
    .into_iter()
    .filter(|path| !path.is_file())
    .map(|path| path.display().to_string())
    .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(assets)
    } else {
        Err(format!(
            "本地 PP-OCRv5 资源缺失：{}。请先在构建期准备版本目录 {} 与 {}。",
            missing.join("；"),
            model_dir.display(),
            runtime_dir.display()
        ))
    }
}

fn resolve_local_assets(app: &tauri::AppHandle) -> Result<LocalOcrAssets, String> {
    let candidates = resource_root_candidates(app);
    let mut errors = Vec::new();
    for root in &candidates {
        match resolve_local_assets_from_root(root) {
            Ok(assets) => return Ok(assets),
            Err(error) => errors.push(format!("{} -> {}", root.display(), error)),
        }
    }
    Err(format!(
        "本地 PP-OCRv5 资源不可用。已检查：{}",
        errors.join(" | ")
    ))
}

#[tauri::command]
pub async fn image_ocr_recognize(
    app: tauri::AppHandle,
    image_base64: String,
) -> Result<ImageOcrResult, String> {
    let bytes = decode_image_bytes(&image_base64)?;

    #[cfg(windows)]
    {
        let app_for_local = app.clone();
        let local_bytes = bytes.clone();
        let local_result = tauri::async_runtime::spawn_blocking(move || {
            local_ocr::recognize(&app_for_local, &local_bytes)
        })
        .await
        .map_err(|error| format!("PP-OCRv5 本地 OCR 任务失败：{error}"))?;
        match local_result {
            Ok(result) => Ok(result),
            Err(local_error) => {
                log::warn!("PP-OCRv5 本地 OCR 失败，回退 Windows.Media.Ocr：{local_error}");
                tauri::async_runtime::spawn_blocking(move || windows_ocr::recognize(&bytes))
                    .await
                    .map_err(|error| format!("Windows.Media.Ocr 回退任务失败：{error}"))?
                    .map_err(|fallback_error| {
                        format!(
                            "PP-OCRv5 本地 OCR 失败：{local_error}；Windows.Media.Ocr 回退也失败：{fallback_error}"
                        )
                    })
            }
        }
    }
    #[cfg(not(windows))]
    {
        tauri::async_runtime::spawn_blocking(move || local_ocr::recognize(&app, &bytes))
            .await
            .map_err(|error| format!("PP-OCRv5 本地 OCR 任务失败：{error}"))?
            .map_err(|error| format!("PP-OCRv5 本地 OCR 失败：{error}"))
    }
}

mod local_ocr {
    use super::{
        normalized_word, resolve_local_assets, ImageOcrBackend, ImageOcrResult, ImageOcrWord,
        LocalOcrAssets, LOCAL_OCR_LANGUAGE,
    };
    use oar_ocr::oarocr::{OAROCRBuilder, OAROCRResult, OAROCR};
    use std::sync::{Mutex, OnceLock};

    static ORT_INIT: OnceLock<Result<(), String>> = OnceLock::new();
    static LOCAL_OCR: OnceLock<Mutex<Option<CachedLocalOcr>>> = OnceLock::new();

    struct CachedLocalOcr {
        assets: LocalOcrAssets,
        engine: OAROCR,
    }

    pub fn recognize(
        app: &tauri::AppHandle,
        bytes: &[u8],
    ) -> Result<ImageOcrResult, Box<dyn std::error::Error + Send + Sync>> {
        let assets = resolve_local_assets(app)?;
        recognize_with_assets(&assets, bytes)
    }

    pub(super) fn recognize_with_assets(
        assets: &LocalOcrAssets,
        bytes: &[u8],
    ) -> Result<ImageOcrResult, Box<dyn std::error::Error + Send + Sync>> {
        ensure_ort_initialized(&assets)?;
        let image = image::load_from_memory(bytes)?.to_rgb8();
        let result = predict_with_cached_ocr(assets, image)?;
        Ok(normalize_result(result))
    }

    fn ensure_ort_initialized(
        assets: &LocalOcrAssets,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        ORT_INIT
            .get_or_init(|| {
                ort::init_from(&assets.ort_library)
                    .map_err(|error| {
                        format!(
                            "无法加载 ONNX Runtime 动态库 {}：{error}",
                            assets.ort_library.display()
                        )
                    })
                    .and_then(|builder| {
                        builder.commit().then_some(()).ok_or_else(|| {
                            format!(
                                "ONNX Runtime 环境已在加载 {} 之前初始化，无法保证 PP-OCRv5 使用打包运行时",
                                assets.ort_library.display()
                            )
                        })
                    })
            })
            .clone()
            .map_err(Into::into)
    }

    fn predict_with_cached_ocr(
        assets: &LocalOcrAssets,
        image: image::RgbImage,
    ) -> Result<OAROCRResult, Box<dyn std::error::Error + Send + Sync>> {
        let cache = LOCAL_OCR.get_or_init(|| Mutex::new(None));
        let mut cache = cache.lock().map_err(|_| "PP-OCRv5 本地 OCR 缓存锁已损坏")?;
        if cache.as_ref().map(|cached| &cached.assets) != Some(assets) {
            *cache = Some(CachedLocalOcr {
                assets: assets.clone(),
                engine: build_engine(assets)?,
            });
        }
        cache
            .as_ref()
            .expect("cached OCR initialized")
            .engine
            .predict(vec![image])?
            .into_iter()
            .next()
            .ok_or_else(|| "PP-OCRv5 未返回识别结果".into())
    }

    fn build_engine(
        assets: &LocalOcrAssets,
    ) -> Result<OAROCR, Box<dyn std::error::Error + Send + Sync>> {
        OAROCRBuilder::new(&assets.det_model, &assets.rec_model, &assets.dict_path)
            .with_text_line_orientation_classification(&assets.orientation_model)
            .return_word_box(true)
            .build()
            .map_err(Into::into)
    }

    fn normalize_result(result: oar_ocr::oarocr::OAROCRResult) -> ImageOcrResult {
        let image = (
            result.input_img.width() as f64,
            result.input_img.height() as f64,
        );
        let mut words = Vec::new();
        let mut lines = Vec::new();
        for region in result
            .text_regions
            .iter()
            .filter(|region| region.text.is_some())
        {
            let text = region.text.as_deref().unwrap_or_default().trim();
            if text.is_empty() {
                continue;
            }
            lines.push(text.to_string());
            words.extend(region_words(region, image));
        }
        ImageOcrResult {
            text: lines.join("\n"),
            language: LOCAL_OCR_LANGUAGE.to_string(),
            words,
            backend: ImageOcrBackend::PpOcrV5,
        }
    }

    fn region_words(region: &oar_ocr::oarocr::TextRegion, image: (f64, f64)) -> Vec<ImageOcrWord> {
        let region_text = region.text.as_deref().unwrap_or_default().trim();
        if region_text.is_empty() {
            return Vec::new();
        }
        let region_rect = (
            region.bounding_box.x_min() as f64,
            region.bounding_box.y_min() as f64,
            (region.bounding_box.x_max() - region.bounding_box.x_min()) as f64,
            (region.bounding_box.y_max() - region.bounding_box.y_min()) as f64,
        );
        let Some(word_boxes) = region.word_boxes.as_ref() else {
            return vec![normalized_word(
                region_text.to_string(),
                region_rect,
                image,
                false,
            )];
        };

        let split_words = region_text.split_whitespace().collect::<Vec<_>>();
        if split_words.len() == word_boxes.len() {
            return split_words
                .into_iter()
                .zip(word_boxes.iter())
                .enumerate()
                .map(|(index, (text, bbox))| {
                    normalized_word(
                        text.to_string(),
                        (
                            bbox.x_min() as f64,
                            bbox.y_min() as f64,
                            (bbox.x_max() - bbox.x_min()) as f64,
                            (bbox.y_max() - bbox.y_min()) as f64,
                        ),
                        image,
                        index + 1 < word_boxes.len(),
                    )
                })
                .collect();
        }

        let chars = region_text
            .chars()
            .map(|ch| ch.to_string())
            .collect::<Vec<_>>();
        if chars.len() == word_boxes.len() {
            return chars
                .into_iter()
                .zip(word_boxes.iter())
                .map(|(text, bbox)| {
                    normalized_word(
                        text,
                        (
                            bbox.x_min() as f64,
                            bbox.y_min() as f64,
                            (bbox.x_max() - bbox.x_min()) as f64,
                            (bbox.y_max() - bbox.y_min()) as f64,
                        ),
                        image,
                        false,
                    )
                })
                .collect();
        }

        vec![normalized_word(
            region_text.to_string(),
            region_rect,
            image,
            false,
        )]
    }
}

#[cfg(windows)]
mod windows_ocr {
    use super::{has_visual_word_gap, normalized_word, ImageOcrBackend, ImageOcrResult};
    use windows::{
        Graphics::Imaging::{
            BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform,
            ColorManagementMode, ExifOrientationMode,
        },
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    pub fn recognize(
        bytes: &[u8],
    ) -> Result<ImageOcrResult, Box<dyn std::error::Error + Send + Sync>> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(bytes)?;
        writer.StoreAsync()?.get()?;
        writer.FlushAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;

        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let original_width = decoder.OrientedPixelWidth()?;
        let original_height = decoder.OrientedPixelHeight()?;
        if original_width == 0 || original_height == 0 {
            return Err("无法读取图片尺寸".into());
        }

        let max_dimension = OcrEngine::MaxImageDimension()?;
        let longest = original_width.max(original_height);
        let transform = BitmapTransform::new()?;
        if longest > max_dimension {
            let scale = max_dimension as f64 / longest as f64;
            transform.SetScaledWidth((original_width as f64 * scale).round().max(1.0) as u32)?;
            transform.SetScaledHeight((original_height as f64 * scale).round().max(1.0) as u32)?;
        }
        let bitmap = decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Premultiplied,
                &transform,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )?
            .get()?;

        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "Windows 未安装与当前用户语言匹配的 OCR 语言包")?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let image_width = bitmap.PixelWidth()? as f64;
        let image_height = bitmap.PixelHeight()? as f64;
        let mut words = Vec::new();
        let mut text_lines = Vec::new();
        let lines = result.Lines()?;
        for line_index in 0..lines.Size()? {
            let line = lines.GetAt(line_index)?;
            let line_words = line.Words()?;
            let mut raw_words = Vec::new();
            for word_index in 0..line_words.Size()? {
                let word = line_words.GetAt(word_index)?;
                let rect = word.BoundingRect()?;
                raw_words.push((
                    word.Text()?.to_string(),
                    (
                        rect.X as f64,
                        rect.Y as f64,
                        rect.Width as f64,
                        rect.Height as f64,
                    ),
                ));
            }
            let mut line_text = String::new();
            for (index, (text, rect)) in raw_words.iter().enumerate() {
                let space_after = raw_words
                    .get(index + 1)
                    .is_some_and(|(_, next)| has_visual_word_gap(*rect, *next));
                line_text.push_str(text);
                if space_after {
                    line_text.push(' ');
                }
                words.push(normalized_word(
                    text.clone(),
                    *rect,
                    (image_width, image_height),
                    space_after,
                ));
            }
            text_lines.push(line_text);
        }

        Ok(ImageOcrResult {
            text: text_lines.join("\n"),
            language: engine.RecognizerLanguage()?.LanguageTag()?.to_string(),
            words,
            backend: ImageOcrBackend::WindowsMediaOcr,
        })
    }

    #[test]
    fn recognizes_real_fixture_when_configured() {
        let Ok(path) = std::env::var("ROCKETX_OCR_TEST_IMAGE") else {
            return;
        };
        let bytes = std::fs::read(path).expect("read OCR fixture");
        let result = recognize(&bytes).expect("recognize fixture");
        println!(
            "language={} backend={:?} text={}",
            result.language,
            result.backend,
            result.text.replace('\n', " | ")
        );
        assert!(!result.language.is_empty());
        assert!(!result.words.is_empty());
        assert!(result.text.contains("RocketX 123"));
        assert!(result.text.contains("本地离线 OCR"));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        development_resource_root, fallback_backend_for_local_failure, has_visual_word_gap,
        local_ocr, normalized_word, resolve_local_assets_from_root, versioned_model_dir,
        versioned_runtime_dir, ImageOcrBackend, ImageOcrResult,
    };
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::path::Path;

    #[test]
    fn normalizes_word_coordinates() {
        let word = normalized_word(
            "OCR".to_owned(),
            (20.0, 10.0, 40.0, 15.0),
            (200.0, 100.0),
            false,
        );
        assert_eq!(word.text, "OCR");
        assert_eq!(
            (word.x, word.y, word.width, word.height),
            (0.1, 0.1, 0.2, 0.15)
        );
        assert!(!word.space_after);
    }

    #[test]
    fn reconstructs_only_visual_word_gaps() {
        assert!(!has_visual_word_gap(
            (10.0, 0.0, 20.0, 40.0),
            (36.0, 0.0, 12.0, 40.0)
        ));
        assert!(has_visual_word_gap(
            (10.0, 0.0, 20.0, 40.0),
            (48.0, 0.0, 12.0, 40.0)
        ));
    }

    #[test]
    fn windows_local_failure_only_falls_back_to_windows_media_ocr() {
        assert_eq!(
            fallback_backend_for_local_failure(true),
            Some(ImageOcrBackend::WindowsMediaOcr)
        );
        assert_eq!(fallback_backend_for_local_failure(false), None);
    }

    #[test]
    fn local_assets_require_versioned_resource_directories() {
        let temp_root = std::env::temp_dir().join(format!(
            "rocketx-ocr-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_root).expect("create temp root");
        let error =
            resolve_local_assets_from_root(&temp_root).expect_err("missing assets should fail");
        assert!(error.contains(&versioned_model_dir(&temp_root).display().to_string()));
        assert!(error.contains(&versioned_runtime_dir(&temp_root).display().to_string()));
        let _ = std::fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn backend_serializes_as_kebab_case() {
        let result = ImageOcrResult {
            text: "RocketX".to_string(),
            language: "zh-Hans,en".to_string(),
            words: Vec::new(),
            backend: ImageOcrBackend::PpOcrV5,
        };
        let value = serde_json::to_value(result).expect("serialize OCR result");
        assert_eq!(
            value.get("backend").and_then(|entry| entry.as_str()),
            Some("pp-ocrv5")
        );
    }

    #[test]
    fn local_pp_ocr_v5_recognizes_bundled_chinese_fixture() {
        let bytes = STANDARD
            .decode(include_str!("../tests/fixtures/ocr-chat-20px.png.b64").trim())
            .expect("decode bundled OCR fixture");
        let assets = resolve_local_assets_from_root(&development_resource_root())
            .expect("local PP-OCRv5 assets should be prepared by build.rs");
        let result = local_ocr::recognize_with_assets(&assets, &bytes)
            .expect("recognize bundled Chinese OCR fixture");
        assert_eq!(result.backend, ImageOcrBackend::PpOcrV5);
        assert!(!result.words.is_empty());
        assert!(result.text.contains("RocketX 123"), "{}", result.text);
        assert!(result.text.contains("本地离线 OCR"), "{}", result.text);
        assert!(
            result.text.contains("项目进度与会议安排"),
            "{}",
            result.text
        );
    }

    #[test]
    fn local_pp_ocr_v5_recognizes_real_fixtures_when_configured() {
        let Ok(fixture_root) = std::env::var("ROCKETX_OCR_TEST_FIXTURE_DIR") else {
            return;
        };
        let assets = resolve_local_assets_from_root(&development_resource_root())
            .expect("local PP-OCRv5 assets should be prepared by build.rs");
        for file_name in ["large-clear.png", "chat-20px.png", "low-contrast-24px.png"] {
            let bytes = std::fs::read(Path::new(&fixture_root).join(file_name))
                .unwrap_or_else(|error| panic!("read fixture {file_name}: {error}"));
            let result = local_ocr::recognize_with_assets(&assets, &bytes)
                .unwrap_or_else(|error| panic!("recognize fixture {file_name}: {error}"));
            let flattened = result.text.replace('\n', " | ");
            println!("{file_name}: {flattened}");
            assert_eq!(result.backend, ImageOcrBackend::PpOcrV5);
            assert!(!result.words.is_empty(), "{file_name}: no words");
            assert!(
                result.text.contains("RocketX 123"),
                "{file_name}: missing RocketX 123 -> {flattened}"
            );
            assert!(
                result.text.contains("本地") || result.text.contains("离线"),
                "{file_name}: missing clear Chinese text -> {flattened}"
            );
        }
    }
}
