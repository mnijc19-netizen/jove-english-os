# Run with Windows PowerShell 5.1 and Node.js 24+. No network or API keys.
[CmdletBinding()]
param(
    [ValidateRange(-3, 3)][int]$Rate = 0,
    [string]$Voice = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$audioRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'public/audio'))
if ($audioRoot -ne [IO.Path]::Combine($projectRoot, 'public', 'audio')) {
    throw 'Audio target is outside the expected project directory.'
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$stageRoot = $null

function Get-TextHash([string]$Value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
    } finally { $hash.Dispose() }
}

function Read-PcmWave([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 44 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ne 'WAVE') {
        throw "Invalid WAV: $Path"
    }
    $foundFormat = $false
    $pcm = $null
    for ($offset = 12; $offset + 8 -le $bytes.Length;) {
        $kind = [Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
        $size = [BitConverter]::ToUInt32($bytes, $offset + 4)
        $start = $offset + 8
        if ($start + $size -gt $bytes.Length) { throw "Truncated WAV: $Path" }
        if ($kind -eq 'fmt ') {
            if ($size -lt 16 -or [BitConverter]::ToUInt16($bytes, $start) -ne 1 -or [BitConverter]::ToUInt16($bytes, $start + 2) -ne 1 -or [BitConverter]::ToUInt32($bytes, $start + 4) -ne 22050 -or [BitConverter]::ToUInt16($bytes, $start + 14) -ne 16) {
                throw "Expected mono 22050 Hz 16-bit PCM: $Path"
            }
            $foundFormat = $true
        }
        if ($kind -eq 'data') {
            $pcm = New-Object byte[] $size
            [Array]::Copy($bytes, $start, $pcm, 0, $size)
        }
        $offset = $start + $size + ($size % 2)
    }
    if (-not $foundFormat -or $null -eq $pcm -or $pcm.Length -lt 4410 -or $pcm.Length % 2 -ne 0) {
        throw "Missing audio or malformed PCM: $Path"
    }
    return @{ Pcm = $pcm; Seconds = $pcm.Length / 44100.0 }
}

function Write-PcmWave([string]$Path, [byte[]]$Pcm) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
    $writer = New-Object IO.BinaryWriter($stream)
    try {
        $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF'))
        $writer.Write([uint32](36 + $Pcm.Length))
        $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
        $writer.Write([uint32]16)
        $writer.Write([uint16]1)
        $writer.Write([uint16]1)
        $writer.Write([uint32]22050)
        $writer.Write([uint32]44100)
        $writer.Write([uint16]2)
        $writer.Write([uint16]16)
        $writer.Write([Text.Encoding]::ASCII.GetBytes('data'))
        $writer.Write([uint32]$Pcm.Length)
        $writer.Write($Pcm)
    } finally { $writer.Dispose(); $stream.Dispose() }
}

try {
    # Native TypeScript stripping keeps materials.ts the sole transcript source.
    Push-Location -LiteralPath $projectRoot
    try {
        $json = & node --input-type=module -e "import { demoMaterials } from './src/content/materials.ts'; process.stdout.write(JSON.stringify(demoMaterials.map(({id, transcript, sentences}) => ({id, transcript, sentences}))));"
        if ($LASTEXITCODE -ne 0) { throw 'Could not load materials.ts; use Node.js 24 or later.' }
        $materials = @((($json -join "`n") | ConvertFrom-Json))
    } finally { Pop-Location }
    if ($materials.Count -lt 5 -or $materials.Count -gt 6) { throw 'Expected five or six reviewed demo materials.' }
    $seenIds = @{}
    foreach ($material in $materials) {
        if ($material.id -notmatch '^[a-z][a-z0-9-]+$' -or $seenIds.ContainsKey($material.id)) { throw 'Invalid or duplicate material id.' }
        $seenIds[$material.id] = $true
        if ($material.sentences.Count -lt 3 -or $material.sentences.Count -gt 6 -or $material.transcript -cne ($material.sentences -join ' ')) {
            throw "Sentence/transcript mismatch: $($material.id)"
        }
    }

    $englishVoices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | ForEach-Object { $_.VoiceInfo.Name })
    if ($englishVoices.Count -eq 0) { throw 'Install an English Windows desktop speech voice before running this script.' }
    if ($Voice) {
        if ($englishVoices -notcontains $Voice) { throw 'The requested voice is not an enabled English desktop voice.' }
        $voiceNames = @($Voice)
    } else {
        $voiceNames = @('Microsoft Zira Desktop', 'Microsoft David Desktop' | Where-Object { $englishVoices -contains $_ })
        if ($voiceNames.Count -eq 0) { $voiceNames = @($englishVoices | Sort-Object) }
    }
    $synth.Rate = $Rate
    $synth.Volume = 100
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    New-Item -ItemType Directory -Path $audioRoot -Force | Out-Null
    $stageRoot = Join-Path $audioRoot ('.generate-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    $entries = @()

    for ($materialIndex = 0; $materialIndex -lt $materials.Count; $materialIndex++) {
        $material = $materials[$materialIndex]
        $selectedVoice = $voiceNames[$materialIndex % $voiceNames.Count]
        $synth.SelectVoice($selectedVoice)
        $sentenceEntries = @()
        $combined = New-Object IO.MemoryStream
        try {
            for ($index = 0; $index -lt $material.sentences.Count; $index++) {
                $filename = "$($material.id)-$index.wav"
                $path = Join-Path $stageRoot $filename
                $synth.SetOutputToWaveFile($path, $format)
                try { $synth.Speak([string]$material.sentences[$index]) }
                finally { $synth.SetOutputToNull() }
                $wave = Read-PcmWave $path
                $combined.Write($wave.Pcm, 0, $wave.Pcm.Length)
                $sentenceEntries += [ordered]@{
                    index = $index; file = "audio/$filename"; duration = $wave.Seconds
                    textSha256 = Get-TextHash $material.sentences[$index]
                    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            }
            $fullName = "$($material.id).wav"
            $fullPath = Join-Path $stageRoot $fullName
            Write-PcmWave $fullPath $combined.ToArray()
        } finally { $combined.Dispose() }
        $fullWave = Read-PcmWave $fullPath
        if ($fullWave.Seconds -lt 15 -or $fullWave.Seconds -gt 60) { throw "Material outside 15-60 seconds: $($material.id)" }
        $entries += [ordered]@{
            id = $material.id; file = "audio/$fullName"; duration = $fullWave.Seconds
            voice = $selectedVoice; rate = $Rate; transcriptSha256 = Get-TextHash $material.transcript
            sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
            sentences = $sentenceEntries
        }
        Write-Host ("{0}: {1:N2}s, {2}, {3} sentences" -f $material.id, $fullWave.Seconds, $selectedVoice, $sentenceEntries.Count)
    }
    $manifest = [ordered]@{
        schemaVersion = 1; generator = 'Windows System.Speech; original reviewed demo / synthetic speech'
        sampleRate = 22050; channels = 1; bitsPerSample = 16; sentenceIndexBase = 0
        materials = $entries
    }
    $manifestPath = Join-Path $stageRoot 'manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", (New-Object Text.UTF8Encoding($false)))
    # Publish only after the entire synthesis batch passes validation. No user audio is enumerated or removed.
    $publishFiles = @($entries | ForEach-Object { ($_.file -replace '^audio/', ''); $_.sentences | ForEach-Object { $_.file -replace '^audio/', '' } }) + @('manifest.json')
    foreach ($filename in $publishFiles) {
        $target = [IO.Path]::GetFullPath((Join-Path $audioRoot $filename))
        if ([IO.Path]::GetDirectoryName($target) -ne $audioRoot) { throw 'Unsafe output target.' }
        Move-Item -LiteralPath (Join-Path $stageRoot $filename) -Destination $target -Force
    }
    Write-Host "Generated $($publishFiles.Count - 1) WAV files and audio/manifest.json. Run the content tests and reconcile rounded Material.duration values if the voice/rate changed."
} finally {
    $synth.Dispose()
    if ($null -ne $stageRoot -and (Test-Path -LiteralPath $stageRoot)) {
        $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
        if ([IO.Path]::GetDirectoryName($resolvedStage) -ne $audioRoot -or [IO.Path]::GetFileName($resolvedStage) -notmatch '^\.generate-[0-9a-f]{32}$') {
            throw 'Refusing to remove an unexpected staging path.'
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
