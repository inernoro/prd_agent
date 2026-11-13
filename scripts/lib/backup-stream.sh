# Portable sh: a successful gzip must never hide a failed database export/SSH.
# The FIFO bounds buffering and avoids a second uncompressed database copy.
cds_backup_stream() (
  set -eu
  stream_archive=$1
  shift
  stream_dir=$(mktemp -d "$(dirname -- "$stream_archive")/.export-pipe.XXXXXX")
  stream_fifo=$stream_dir/bytes
  trap 'rm -f "$stream_fifo"; rmdir "$stream_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  mkfifo -m 600 "$stream_fifo"
  "$@" > "$stream_fifo" &
  stream_pid=$!
  stream_status=0
  gzip < "$stream_fifo" > "$stream_archive" || stream_status=$?
  wait "$stream_pid" || stream_status=$?
  [ "$stream_status" -eq 0 ] || {
    echo 'ERROR: 备份导出或压缩失败；不签发完成证明，已有文件继续保留。' >&2
    exit "$stream_status"
  }
  gzip -t "$stream_archive"
)
