# Test-only local server for the iPhone Simulator run. Serves the app checkout (main) at /ryans-reel-kit/
# and this harness at /ci/. Never deployed: GitHub Pages serves main only.
import http.server, json, os, subprocess, sys, threading, urllib.parse, time
APP = os.path.abspath(sys.argv[1]); CI = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.abspath(sys.argv[2])
os.makedirs(OUT, exist_ok=True)
STATE = {'offline': False}
TYPES = {'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream', '.txt': 'text/plain', '.md': 'text/plain'}
def log(line):
    with open(os.path.join(OUT, 'results.jsonl'), 'a') as f: f.write(line + '\n')
    print(line, flush=True)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body=b'', ctype='text/plain'):
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith('/ryans-reel-kit/'):
            if STATE['offline']:
                self.close_connection = True; self.connection.close(); return  # simulate no network
            rel = p[len('/ryans-reel-kit/'):] or 'index.html'; base = APP
        elif p.startswith('/ci/'): rel = p[4:]; base = CI
        else: return self.send(404)
        fp = os.path.normpath(os.path.join(base, rel))
        if not fp.startswith(base) or not os.path.isfile(fp): return self.send(404)
        with open(fp, 'rb') as f: self.send(200, f.read(), TYPES.get(os.path.splitext(fp)[1], 'application/octet-stream'))
    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = dict(urllib.parse.parse_qsl(u.query))
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if u.path == '/ci/log': log(body.decode('utf-8', 'replace'))
        elif u.path == '/ci/shot':
            name = ''.join(c for c in q.get('name', 'shot') if c.isalnum() or c in '-_')
            try: subprocess.run(['xcrun', 'simctl', 'io', 'booted', 'screenshot', os.path.join(OUT, name + '.png')], capture_output=True, timeout=30)
            except Exception as e: log(json.dumps({'shot_error': str(e)}))
        elif u.path == '/ci/offline': STATE['offline'] = q.get('on') == '1'; log(json.dumps({'offline': STATE['offline']}))
        elif u.path == '/ci/upload':
            name = os.path.basename(q.get('name', 'upload.bin'))
            with open(os.path.join(OUT, name), 'wb') as f: f.write(body)
        elif u.path == '/ci/done': open(os.path.join(OUT, 'done'), 'w').write('1')
        self.send(200, b'ok')
http.server.ThreadingHTTPServer(('127.0.0.1', 8123), H).serve_forever()
