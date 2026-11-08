$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = [IO.Path]::GetFullPath($env:BGM_CADENS_ZIP)
$destination = [IO.Path]::GetFullPath($env:BGM_CADENS_DEST)
if (Test-Path -LiteralPath $destination) { throw 'Destination already exists' }
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $prefix = $destination.TrimEnd('\') + '\'
    $expandedBytes = 0L
    if ($archive.Entries.Count -gt 100000) { throw 'Too many archive entries' }
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('/', '\')
        if ($name.Contains(':') -or [IO.Path]::IsPathRooted($name)) { throw 'Unsafe archive path' }
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $name))
        if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
        $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if ($mode -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400)) { throw 'Archive links are not supported' }
        $expandedBytes += $entry.Length
        if ($expandedBytes -gt 8GB) { throw 'Archive expands beyond 8 GiB' }
    }
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($entry in $archive.Entries) {
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $entry.FullName.Replace('/', '\')))
        if ($entry.Name -eq '') { [IO.Directory]::CreateDirectory($target) | Out-Null }
        else {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    }
} finally { $archive.Dispose() }
