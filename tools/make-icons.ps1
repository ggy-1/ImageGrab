# 生成扩展图标（16/32/48/128 PNG）
# 用法： powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($s in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 圆角矩形底板
  $r = [Math]::Max(2, [int]($s * 0.22))
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $path.AddArc(0, $s - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 192, 97),
    [System.Drawing.Color]::FromArgb(255, 226, 116, 13),
    55)
  $g.FillPath($brush, $path)

  # 深色下载箭头
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 29, 18, 5), [Math]::Max(1.4, $s * 0.085))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cx = $s / 2.0
  $g.DrawLine($pen, $cx, $s * 0.22, $cx, $s * 0.6)
  $g.DrawLine($pen, $s * 0.33, $s * 0.43, $cx, $s * 0.6)
  $g.DrawLine($pen, $s * 0.67, $s * 0.43, $cx, $s * 0.6)
  $g.DrawLine($pen, $s * 0.26, $s * 0.78, $s * 0.74, $s * 0.78)

  $file = Join-Path $outDir ("icon{0}.png" -f $s)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("wrote {0}" -f $file)

  $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
}
