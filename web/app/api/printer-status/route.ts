import { execFile } from "child_process";
import { promisify } from "util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const POWERSHELL_SCRIPT = `
$printers = Get-CimInstance -ClassName Win32_Printer |
  Select-Object Name,Default,WorkOffline,PrinterStatus,DetectedErrorState;
$default = $printers | Where-Object { $_.Default -eq $true } | Select-Object -First 1;
if (-not $default) { $default = $printers | Select-Object -First 1 }
$info = @{ available = $false; status = "unavailable" };
if ($default) {
  $offline = $default.WorkOffline -eq $true
  $error = $default.DetectedErrorState
  $statusCode = $default.PrinterStatus
  $status = if ($offline) { "offline" } elseif ($error -and $error -ne 0) { "error" } elseif ($statusCode -eq 3) { "ready" } else { "unknown" }
  $info = @{
    available = $true
    name = $default.Name
    offline = $offline
    statusCode = $statusCode
    errorCode = $error
    status = $status
  }
}
$info | ConvertTo-Json -Compress
`;

export async function GET() {
  if (process.platform !== "win32") {
    return NextResponse.json({
      available: false,
      status: "unsupported",
    });
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", POWERSHELL_SCRIPT],
      { timeout: 8000, maxBuffer: 1024 * 1024 },
    );
    const text = stdout.trim();
    const data = text ? JSON.parse(text) : { available: false, status: "unknown" };
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ available: false, status: "unavailable" });
  }
}
