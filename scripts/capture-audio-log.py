#!/usr/bin/env python3
"""Passive serial capture. Sends no serial data or deliberate reset sequence.

Opening this port can still reset the device through macOS modem-control
handling. Keep one capture open across comparisons to avoid repeated opens.

Raw device logs may contain credentials; save them privately and print only
fixed markers. Missing RX log messages mean unknown, never zero audio packets.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import termios
import time

import serial


def summarize(data):
    text = re.sub(r'\x1b\[[0-9;]*m', '', data.decode('utf-8', errors='replace'))
    states = re.findall(r'(?:State:\s*\w+\s*->\s*|STATE:\s*(?!\w+\s*->))(idle|listening|speaking|connecting)\b', text, re.I)
    markers = {
        'system_status': r'SystemInfo:',
        'mqtt': r'\bMQTT:',
        'websocket': r'\b(?:WS|WebSocket):',
        'assistant_subtitle': r'Application:\s*<<',
        'output_enabled': r'(?:Set output enable to true|Speaker enabled)',
        'output_disabled': r'(?:Set output enable to false|Speaker disabled)',
        'audio_resample': r'Resampling audio',
        'sequence_warning': r'(?:wrong sequence|old sequence)',
        'decode_error': r'(?:opus.*(?:fail|error)|(?:fail|error).*opus|decode.*(?:fail|error))',
        'codec_error': r'\bE\s+[^\r\n]*(?:i2s|codec)',
        'abort': r'Abort speaking',
        'boot': r'(?:ESP-ROM:|rst:0x|Bootloader:)',
    }
    return {
        'bytes': len(data),
        'states': states[-50:],
        'markers': {key: len(re.findall(pattern, text, re.I)) for key, pattern in markers.items()},
        'received_audio_packets': None,
        'rx_note': 'unknown; stock logs do not provide a reliable received-packet counter',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True, help='Serial port path; specify the connected device explicitly.')
    parser.add_argument('--seconds', type=float, default=12)
    parser.add_argument('--label', default='passive')
    parser.add_argument('--dtr', choices=['on', 'off'], default='off')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600 or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', args.label):
        parser.error('seconds must be 1..600; label must be a short safe identifier')
    root = Path(__file__).resolve().parent.parent / '.local' / 'audio-captures'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    raw_path = root / f'{stamp}-{args.label}.log'
    summary_path = raw_path.with_suffix('.json')
    port = serial.Serial(port=None, baudrate=115200, timeout=0.2, exclusive=True)
    port.rts = False
    port.dtr = False
    port.port = args.port
    captured = bytearray()
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    try:
        port.open()
        port.rts = False
        # Do not drop modem control lines as a hang-up/reset on close.
        attributes = termios.tcgetattr(port.fileno())
        attributes[2] &= ~termios.HUPCL
        termios.tcsetattr(port.fileno(), termios.TCSANOW, attributes)
        port.dtr = args.dtr == 'on'
        print(json.dumps({'capture_started': True, 'label': args.label}), flush=True)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline and len(captured) < 4 * 1024 * 1024:
            captured.extend(port.read(min(max(port.in_waiting, 1), 65536)))
    except KeyboardInterrupt:
        pass
    finally:
        if port.is_open:
            port.dtr = False
            port.close()
    descriptor = os.open(raw_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(captured)
    result = {
        'started_at': started,
        'finished_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'label': args.label,
        'dtr': args.dtr,
        'raw_log': str(raw_path),
        **summarize(captured),
    }
    descriptor = os.open(summary_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (serial.SerialException, OSError) as error:
        print(json.dumps({'capture_failed': type(error).__name__}))
        raise SystemExit(1)
