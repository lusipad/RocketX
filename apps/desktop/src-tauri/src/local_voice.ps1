$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Only in-process Windows SAPI engines are used. No microphone or audio device
# is opened here; all audio stays in bounded memory streams.
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.Speech
    # Limit this adapter to the Windows desktop recognizer/voices. Arbitrary
    # third-party SAPI providers can have their own network behavior.
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Id -match '^MS-[0-9]+-80-DESK$' })
    if ($request.operation -eq 'probe') {
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -match '^Microsoft .+ Desktop$' } | ForEach-Object {
                @{ id = $_.VoiceInfo.Name; name = $_.VoiceInfo.Name; language = $_.VoiceInfo.Culture.Name }
            })
            $engines = @($recognizers | ForEach-Object {
                @{ id = $_.Id; name = $_.Name; language = $_.Culture.Name }
            })
            $result = @{ available = ($engines.Count -gt 0 -or $voices.Count -gt 0); platform = 'windows'; recognizers = $engines; voices = $voices }
            if (-not $result.available) { $result.reason = '未安装受支持的 Windows 离线识别引擎或 Microsoft Desktop 本地音库。' }
        } finally { $synth.Dispose() }
    } elseif ($request.operation -eq 'transcribe') {
        $info = $recognizers | Where-Object { $_.Culture.Name -eq $request.language } | Select-Object -First 1
        if ($null -eq $info) { throw 'LOCAL_VOICE_UNSUPPORTED: 此语言未安装受支持的 Windows 离线识别引擎。' }
        $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
        $stream = New-Object System.IO.MemoryStream(, [Convert]::FromBase64String($request.audioBase64))
        try {
            $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
            $recognizer.SetInputToWaveStream($stream)
            $parts = New-Object 'System.Collections.Generic.List[string]'
            $confidence = New-Object 'System.Collections.Generic.List[double]'
            while ($true) {
                try { $recognized = $recognizer.Recognize([TimeSpan]::FromSeconds(30)) }
                catch {
                    # The Windows dictation engine may release its WAV input
                    # at EOF immediately after returning the final result.
                    if ($parts.Count -gt 0 -and $recognizer.AudioState -eq [System.Speech.Recognition.AudioState]::Stopped -and $_.Exception.InnerException -is [InvalidOperationException]) { break }
                    throw
                }
                if ($null -eq $recognized) { break }
                if (-not [string]::IsNullOrWhiteSpace($recognized.Text)) {
                    $parts.Add($recognized.Text)
                    $confidence.Add($recognized.Confidence)
                }
                if ($parts.Count -ge 100) { break }
            }
            $result = @{ text = [string]::Join(' ', $parts); language = $info.Culture.Name; durationMs = $request.durationMs }
            if ($confidence.Count -gt 0) { $result.confidence = ($confidence | Measure-Object -Average).Average }
        } finally { $recognizer.Dispose(); $stream.Dispose() }
    } elseif ($request.operation -eq 'synthesize') {
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $stream = New-Object System.IO.MemoryStream
        try {
            $voice = $synth.GetInstalledVoices() | Where-Object {
                $_.Enabled -and $_.VoiceInfo.Name -match '^Microsoft .+ Desktop$' -and $(if ($request.voiceId) { $_.VoiceInfo.Name -eq $request.voiceId } else { $_.VoiceInfo.Culture.Name -eq $request.language })
            } | Select-Object -First 1
            if ($null -eq $voice) { throw 'LOCAL_VOICE_UNSUPPORTED: 未安装所选语言或声音的 Microsoft Desktop 本地音库。' }
            $synth.SelectVoice($voice.VoiceInfo.Name)
            $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
            $synth.SetOutputToAudioStream($stream, $format)
            $synth.Speak([string]$request.text)
            $synth.SetOutputToNull()
            $pcm = $stream.ToArray()
            if ($pcm.Length -eq 0 -or $pcm.Length -gt 3840000) { throw 'LOCAL_VOICE_LIMIT: 朗读没有生成音频或超过 120 秒。' }
            $wave = New-Object System.IO.MemoryStream
            $writer = New-Object System.IO.BinaryWriter($wave)
            try {
                $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF'))
                $writer.Write([uint32](36 + $pcm.Length))
                $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
                $writer.Write([uint32]16)
                $writer.Write([uint16]1)
                $writer.Write([uint16]1)
                $writer.Write([uint32]16000)
                $writer.Write([uint32]32000)
                $writer.Write([uint16]2)
                $writer.Write([uint16]16)
                $writer.Write([Text.Encoding]::ASCII.GetBytes('data'))
                $writer.Write([uint32]$pcm.Length)
                $writer.Write($pcm)
                $writer.Flush()
                $result = @{ audioBase64 = [Convert]::ToBase64String($wave.ToArray()); mimeType = 'audio/wav'; language = $voice.VoiceInfo.Culture.Name }
            } finally { $writer.Dispose(); $wave.Dispose() }
        } finally { $synth.Dispose(); $stream.Dispose() }
    } else { throw 'LOCAL_VOICE_INVALID: Unknown operation.' }
    $result | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
