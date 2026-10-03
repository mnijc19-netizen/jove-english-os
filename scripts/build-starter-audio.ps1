param([string]$ContentModule = '.work/starter-content.mjs')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$starterRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$modulePath = [IO.Path]::GetFullPath((Join-Path $starterRoot $ContentModule))
if (-not $modulePath.StartsWith($starterRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Content module must be in this repository.' }
$moduleUri = ([Uri]$modulePath).AbsoluteUri
$moduleLiteral = $moduleUri | ConvertTo-Json -Compress
$planSource = "import($moduleLiteral).then(({starterLessons}) => process.stdout.write(JSON.stringify(starterLessons.map(lesson => ({ id:lesson.id, language:lesson.language, version:lesson.version, texts:[...new Set([lesson.model.text,lesson.scaffold.answer,lesson.expression.reference,...lesson.transfer.map(item=>item.reference)])] })))));"
$plan = (& node --input-type=module -e $planSource) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $plan.Count -ne 6) { throw 'Expected exactly six original starter lesson packages.' }
$starterAudioRoot = [IO.Path]::GetFullPath((Join-Path $starterRoot 'public\audio\starter'))
if (-not $starterAudioRoot.StartsWith([IO.Path]::GetFullPath((Join-Path $starterRoot 'public\audio')) + [IO.Path]::DirectorySeparatorChar)) { throw 'Invalid generated audio path.' }
New-Item -ItemType Directory -Path $starterAudioRoot -Force | Out-Null
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$assets = @()
try {
  foreach ($lesson in $plan) {
    if ($lesson.id -notmatch '^(en|ja)-starter-[1-3]$') { throw 'Unexpected lesson identity.' }
    $voice = if ($lesson.language -eq 'en') { 'Microsoft Zira Desktop' } else { 'Microsoft Haruka Desktop' }
    $synth.SelectVoice($voice)
    $synth.Rate = 0
    for ($index = 0; $index -lt $lesson.texts.Count; $index++) {
      $stem = $lesson.id + $(if ($index -gt 0) { '-' + $index } else { '' })
      $target = Join-Path $starterAudioRoot ($stem + '.wav')
      $synth.SetOutputToWaveFile($target, $format)
      $synth.Speak([string]$lesson.texts[$index])
      $synth.SetOutputToNull()
      $bytes = [IO.File]::ReadAllBytes($target)
      if ($bytes.Length -lt 5000 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { throw 'Invalid generated WAV.' }
      $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
      $textBytes = [Text.Encoding]::UTF8.GetBytes([string]$lesson.texts[$index])
      $textHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($textBytes)).ToLowerInvariant()
      $assets += [pscustomobject]@{ lessonId=$lesson.id; lessonVersion=$lesson.version; text=[string]$lesson.texts[$index]; language=$lesson.language;
        path=('audio/starter/' + $stem + '.wav'); voice=$voice; synthetic=$true; rate=0;
        sha256=$hash; textSha256=$textHash; byteLength=$bytes.Length; sampleRate=22050; channels=1; bitsPerSample=16 }
    }
  }
} finally { $synth.Dispose() }
# Generated provenance accompanies generated binary assets, never an API key or learner record.
$manifest = [pscustomobject]@{ version=1; generator='Windows System.Speech'; rights='Original course examples; no copied publisher media';
  qualityClaim='Supplemental localized synthetic demonstration, not human speech or calibrated acoustic assessment'; assets=$assets }
[IO.File]::WriteAllText((Join-Path $starterAudioRoot 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$assets | Select-Object lessonId, path, voice, byteLength
