# setup-llamacpp.ps1 - Download and compile llama.cpp
#
# Usage: .\scripts\setup-llamacpp.ps1
#
# Flow:
# 1. Check if libs/llama.cpp exists
#    - Exists and is a git repo -> git pull
#    - Exists but not git -> skip download, compile directly
#    - Does not exist -> git clone https://github.com/ggerganov/llama.cpp.git libs/llama.cpp
# 2. Check if CMake is available
# 3. cmake -S libs/llama.cpp -B libs/llama.cpp/build -DGGML_CUDA=OFF -DLLAMA_CURL=ON
# 4. cmake --build libs/llama.cpp/build --config Release --target llama-server
# 5. Verify binary libs/llama.cpp/build/bin/Release/llama-server.exe exists
# 6. Output path

param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$LlamaDir = Join-Path $Root "libs\llama.cpp"
$BuildDir = Join-Path $LlamaDir "build"
$ServerExe = Join-Path $BuildDir "bin\Release\llama-server.exe"

Write-Host "[setup-llamacpp] Checking llama.cpp..." -ForegroundColor Cyan

# ── Pre-flight: check Git ──
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Host "[setup-llamacpp] ERROR: Git not found." -ForegroundColor Red
    Write-Host "  Please install Git from: https://git-scm.com/download/win" -ForegroundColor Yellow
    Write-Host "  After installation, restart your terminal and run this script again." -ForegroundColor Yellow
    exit 1
}

# ── Pre-flight: check CMake ──
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) {
    Write-Host "[setup-llamacpp] ERROR: CMake not found." -ForegroundColor Red
    Write-Host "  Please install CMake from: https://cmake.org/download/" -ForegroundColor Yellow
    Write-Host "  During installation, check 'Add CMake to the system PATH'." -ForegroundColor Yellow
    Write-Host "  After installation, restart your terminal and run this script again." -ForegroundColor Yellow
    exit 1
}
Write-Host "[setup-llamacpp] Git: $($git.Source)" -ForegroundColor Gray
Write-Host "[setup-llamacpp] CMake: $($cmake.Source)" -ForegroundColor Gray

# ── Fast path: binary already exists → skip everything ──
if (Test-Path $ServerExe) {
    Write-Host "[setup-llamacpp] llama-server already built at: $ServerExe" -ForegroundColor Green
    exit 0
}

# ── Clone / Pull ──
if (Test-Path $LlamaDir) {
    if (Test-Path (Join-Path $LlamaDir ".git")) {
        Write-Host "[setup-llamacpp] Updating existing repository..." -ForegroundColor Yellow
        Push-Location $LlamaDir
        git pull origin master --ff-only
        Pop-Location
    } else {
        Write-Host "[setup-llamacpp] Directory exists but not a git repo, using as-is." -ForegroundColor Yellow
    }
} else {
    Write-Host "[setup-llamacpp] Cloning llama.cpp (this may take a few minutes)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path (Split-Path $LlamaDir -Parent) | Out-Null
    git clone --depth 1 https://github.com/ggerganov/llama.cpp.git $LlamaDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[setup-llamacpp] ERROR: Failed to clone llama.cpp." -ForegroundColor Red
        Write-Host "  Please check your network connection and try again." -ForegroundColor Yellow
        exit 1
    }
}

# ── Configure (only if build dir doesn't have CMakeCache yet) ──
$cacheFile = Join-Path $BuildDir "CMakeCache.txt"
if (-not (Test-Path $cacheFile)) {
    Write-Host "[setup-llamacpp] Configuring CMake (this may take a minute)..." -ForegroundColor Yellow
    $cmakeArgs = @(
        "-S", $LlamaDir,
        "-B", $BuildDir,
        "-DGGML_CUDA=OFF",
        "-DLLAMA_CURL=ON"
    )
    & cmake @cmakeArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[setup-llamacpp] ERROR: CMake configure failed." -ForegroundColor Red
        Write-Host "  Make sure Visual Studio Build Tools (MSVC) are installed." -ForegroundColor Yellow
        Write-Host "  Download from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022" -ForegroundColor Yellow
        Write-Host "  During installation, select 'Desktop development with C++' workload." -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "[setup-llamacpp] Already configured, skipping cmake configure." -ForegroundColor Gray
}

# ── Build ──
Write-Host "[setup-llamacpp] Building llama-server (this may take several minutes)..." -ForegroundColor Yellow
$jobs = $env:NUMBER_OF_PROCESSORS
if (-not $jobs) { $jobs = [Environment]::ProcessorCount }
& cmake --build $BuildDir --config Release --target llama-server -j $jobs
if ($LASTEXITCODE -ne 0) {
    Write-Host "[setup-llamacpp] ERROR: Build failed." -ForegroundColor Red
    Write-Host "  Check the output above for compilation errors." -ForegroundColor Yellow
    Write-Host "  Common issues:" -ForegroundColor Yellow
    Write-Host "    - Missing MSVC: install Visual Studio Build Tools" -ForegroundColor Yellow
    Write-Host "    - Insufficient disk space" -ForegroundColor Yellow
    exit 1
}

# ── Verify ──
if (Test-Path $ServerExe) {
    Write-Host "[setup-llamacpp] SUCCESS! Binary at: $ServerExe" -ForegroundColor Green
    Write-Host "[setup-llamacpp] Next: download a GGUF model file to models/ directory" -ForegroundColor Cyan
    Write-Host "[setup-llamacpp] Recommended: qwen2.5-7b-instruct (https://huggingface.co/Qwen)" -ForegroundColor Cyan
} else {
    Write-Host "[setup-llamacpp] ERROR: Build completed but binary not found at: $ServerExe" -ForegroundColor Red
    Write-Host "  Expected path: $ServerExe" -ForegroundColor Yellow
    Write-Host "  Try checking the build directory for errors." -ForegroundColor Yellow
    exit 1
}