param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$resolved = (Resolve-Path -LiteralPath $InstallerPath).ProviderPath
$file = Get-Item -LiteralPath $resolved -Force
if (-not ($file -is [System.IO.FileInfo])) {
  throw "Native Windows installer is not a regular file"
}
if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Native Windows installer is a reparse point"
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status.ToString() -ne "Valid") {
  throw "Authenticode signature status is $($signature.Status): $($signature.StatusMessage)"
}
if ($signature.SignatureType.ToString() -ne "Authenticode") {
  throw "Windows installer is not embedded Authenticode signed"
}
if ($null -eq $signature.SignerCertificate) {
  throw "Authenticode signer certificate is missing"
}
if ($null -eq $signature.TimeStamperCertificate) {
  throw "Authenticode trusted timestamp is missing"
}

$codeSigningOid = "1.3.6.1.5.5.7.3.3"
$timestampingOid = "1.3.6.1.5.5.7.3.8"
$hasCodeSigningEku = @($signature.SignerCertificate.Extensions |
  Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
  ForEach-Object { $_.EnhancedKeyUsages } |
  Where-Object { $_.Value -eq $codeSigningOid }).Count -gt 0
$hasTimestampingEku = @($signature.TimeStamperCertificate.Extensions |
  Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
  ForEach-Object { $_.EnhancedKeyUsages } |
  Where-Object { $_.Value -eq $timestampingOid }).Count -gt 0
if (-not $hasCodeSigningEku) {
  throw "Authenticode signer certificate lacks the Code Signing EKU"
}
if (-not $hasTimestampingEku) {
  throw "Authenticode timestamp certificate lacks the Time Stamping EKU"
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $certificateSha256 = [System.BitConverter]::ToString(
    $sha256.ComputeHash($signature.SignerCertificate.RawData)
  ).Replace("-", "")
} finally {
  $sha256.Dispose()
}

[ordered]@{
  status = $signature.Status.ToString()
  signatureType = $signature.SignatureType.ToString()
  certificateSubject = $signature.SignerCertificate.Subject
  certificateSha256 = $certificateSha256
  hasCodeSigningEku = $hasCodeSigningEku
  hasTrustedTimestamp = $true
} | ConvertTo-Json -Compress
