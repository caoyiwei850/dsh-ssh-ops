// Seed text for the color-scheme preview. It reads as one short log excerpt so
// the preview has a point: check an app log, see a disk warning with the
// cleanup skipped, a refused database connection (Chinese detail quoted as a
// string value), the successful retry, the log directory permissions and a
// service status check. It must exercise every built-in classification
// (errors, success, warnings, information, addresses/time, numbers,
// strings/paths, options, commands, file permissions, prompts) and it includes
// CJK characters because the matcher maps them back to terminal cell widths.
// The run of eight lines fits the preview without scrolling at the default font.
// This is sample terminal output, not UI copy: the lines stay outside the
// translation dictionary (hence the i18n-ignore markers below).
export const DEFAULT_PREVIEW_TEXT = [
  "demo@host:~$ cat --lines=42 /var/log/app.log",
  "2026-10-30 12:30:15 INFO  service started on 192.168.1.10:2222",
  "2026-10-30 12:30:16 WARNING disk 87% full, cleanup skipped",
  '2026-10-30 12:30:17 ERROR connection refused: "数据库连接被拒绝"', // i18n-ignore
  '2026-10-30 12:30:18 SUCCESS retry 2/5: "重试成功"', // i18n-ignore
  "2026-10-30 12:30:19 INFO  peer 2001:db8::1 MAC 00:1A:2B:3C:4D:5E connected",
  "drwxr-xr-x 2 demo staff 4096 Oct 30 12:30 /srv/app/logs",
  "demo@host:~$ sudo systemctl status nginx"
].join("\n");
