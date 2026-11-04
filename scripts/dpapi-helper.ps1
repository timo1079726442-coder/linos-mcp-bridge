# DPAPI helper for SecretStore. Reads plaintext from stdin, returns
# base64-encoded ProtectedData on stdout. NEVER echoes the plaintext.

# Modes:
#   stdin starts with "!DECRYPT:<base64>"  -> decrypt and print plaintext
#   otherwise                              -> encrypt and print base64

$ErrorActionPreference = 'SilentlyContinue'

try {
  Add-Type -AssemblyName System.Security
} catch {
  exit 1
}

# Read all of stdin
$plaintext = [Console]::In.ReadToEnd()

if ($plaintext.StartsWith('!DECRYPT:')) {
  $b64 = $plaintext.Substring('!DECRYPT:'.Length)
  try {
    $bytes = [Convert]::FromBase64String($b64)
    $decoded = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $bytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($decoded))
  } catch {
    exit 1
  }
} else {
  try {
    $bytes = [System.Security.Cryptography.ProtectedData]::Protect(
      [System.Text.Encoding]::UTF8.GetBytes($plaintext),
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  } catch {
    exit 1
  }
}