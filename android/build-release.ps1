$ErrorActionPreference = 'Stop'

$requiredVariables = @(
    'DSH_ANDROID_KEYSTORE',
    'DSH_ANDROID_KEYSTORE_PASSWORD',
    'DSH_ANDROID_KEY_ALIAS',
    'DSH_ANDROID_KEY_PASSWORD'
)

foreach ($variableName in $requiredVariables) {
    $value = [Environment]::GetEnvironmentVariable($variableName)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Required environment variable is missing: $variableName"
    }
}

if (-not (Test-Path -LiteralPath $env:DSH_ANDROID_KEYSTORE -PathType Leaf)) {
    throw "Keystore does not exist: $env:DSH_ANDROID_KEYSTORE"
}

& "$PSScriptRoot\gradlew.bat" assembleRelease
if ($LASTEXITCODE -ne 0) {
    throw "Gradle release build failed with exit code $LASTEXITCODE"
}
