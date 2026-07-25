Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\17737\.qoder\vibe_images\fn_openpreview_icon_1784965150.png')
$root = 'c:\Users\17737\Code\other\FnOS\开放文件预览器'
$pairs = @(
  @(64, 'fpk\ICON.PNG'),
  @(256, 'fpk\ICON_256.PNG'),
  @(64, 'fpk\app\ui\images\icon_64.png'),
  @(256, 'fpk\app\ui\images\icon_256.png')
)
foreach ($p in $pairs) {
  $size = $p[0]
  $dst = Join-Path $root $p[1]
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "saved $dst"
}
$src.Dispose()
