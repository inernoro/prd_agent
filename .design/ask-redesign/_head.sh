#!/usr/bin/env bash
# 拼一个 .dc.html 的头：格式固定，只有额外样式因文件而异
cat <<'H1'
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <style>
H1
cat _base.css
