use serde::Serialize;

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

#[tauri::command]
pub async fn image_ocr_recognize(image_base64: String) -> Result<ImageOcrResult, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || windows_ocr::recognize(&image_base64))
            .await
            .map_err(|error| format!("本地 OCR 任务失败：{error}"))?
            .map_err(|error| format!("本地 OCR 失败：{error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = image_base64;
        Err("本地 OCR 目前仅支持 Windows 桌面端".to_owned())
    }
}

#[cfg(windows)]
mod windows_ocr {
    use super::{has_visual_word_gap, normalized_word, ImageOcrResult};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use windows::{
        Graphics::Imaging::{
            BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform,
            ColorManagementMode, ExifOrientationMode,
        },
        Media::Ocr::OcrEngine,
        Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
    };

    const MAX_ENCODED_IMAGE_BYTES: usize = 28 * 1024 * 1024;

    pub fn recognize(
        encoded: &str,
    ) -> Result<ImageOcrResult, Box<dyn std::error::Error + Send + Sync>> {
        if encoded.is_empty() {
            return Err("图片内容为空".into());
        }
        if encoded.len() > MAX_ENCODED_IMAGE_BYTES {
            return Err("图片过大，OCR 最大支持约 20 MB".into());
        }
        let bytes = STANDARD.decode(encoded)?;
        if bytes.is_empty() {
            return Err("图片内容为空".into());
        }

        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(&bytes)?;
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
        })
    }

    #[test]
    fn recognizes_real_fixture_when_configured() {
        let Ok(path) = std::env::var("ROCKETX_OCR_TEST_IMAGE") else {
            return;
        };
        let bytes = std::fs::read(path).expect("read OCR fixture");
        let encoded = STANDARD.encode(bytes);
        let result = recognize(&encoded).expect("recognize fixture");
        println!(
            "language={} text={}",
            result.language,
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
    use super::{has_visual_word_gap, normalized_word};

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
}
