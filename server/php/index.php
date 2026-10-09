<?php
// Proxy for the meme server: https://<site>/zv/?p=/v1/...
// The server itself is the zvideo docker container on 127.0.0.1:8791 (server/app.py).
// Only API paths pass: the feed, clip preparation and encoded files.
$p = isset($_GET['p']) ? $_GET['p'] : '';
// Zepp on iPhone encodes the URL once more: %2F arrives as %252F and after parsing
// p is still "%2Fv1%2Flist". Decode while there is something to decode
for ($i = 0; $i < 3 && strpos($p, '%') !== false; $i++) {
    $p = rawurldecode($p);
}
if (!preg_match('#^/v1/(health|list|prepare|f/[A-Za-z0-9]{3,20}-(low|mid|high)\.zv)$#', $p)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"err":"Не найдено"}'; // shown on the watch, hence Russian
    exit;
}
$q = $_GET;
unset($q['p']);
$url = 'http://127.0.0.1:8791' . $p . ($q ? '?' . http_build_query($q) : '');
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 60,
]);
$out = curl_exec($ch);
if ($out === false) {
    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"state":"error","err":"Сервер мемов не отвечает"}';
    exit;
}
http_response_code(curl_getinfo($ch, CURLINFO_RESPONSE_CODE));
header('Content-Type: ' . (curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: 'application/octet-stream'));
header('Content-Length: ' . strlen($out));
header('Cache-Control: no-store');
echo $out;
