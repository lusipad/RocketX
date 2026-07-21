#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ipmsg_probe.py — 飞鸽 / 飞秋 / 内网通 2425 协议探测器。

用途:在真实局域网里定位 RocketX 与旧协议客户端(飞鸽传书 / 飞秋 / 内网通)
互通失败的具体环节。只依赖 Python 3.8+ 标准库,Windows / macOS / Linux 均可运行。

子命令:
  listen                  监听 UDP 2425,解码并打印收到的每一个报文
                          (同时给出 GBK / CP932 / UTF-8 三种解码视图)。
  probe <ip> [...]        向目标依次发送 4 种方言的 BR_ENTRY 上线宣告,
                          统计哪种方言得到了 ANSENTRY 应答。
  announce                向广播地址发送 4 种方言的 BR_ENTRY,收集全网应答,
                          用于摸清网段里有哪些旧协议客户端、各自说什么方言。
  send <ip> <text>        以指定方言发送一条消息并等待 RECVMSG 回执。

典型排查流程:
  1. 在装有飞秋/内网通的机器旁边任找一台机器: python ipmsg_probe.py announce
     —— 能看到谁在线、说什么方言;什么都看不到说明广播被防火墙/AP 隔离挡了。
  2. 对 RocketX 所在机器: python ipmsg_probe.py probe <RocketX 的 IP>
     —— 逐方言验证 RocketX 会应答哪种客户端。
  3. python ipmsg_probe.py listen 挂着,再在 RocketX 里启用插件,
     观察它广播出来的版本串与编码。

若 2425 端口绑定失败,说明本机已有飞鸽/飞秋/内网通/RocketX 在占用 —— 同一台
机器上两个 2425 客户端无法共存,这本身就是常见的"互通失败"原因之一。
"""

import argparse
import socket
import struct
import sys
import time
import uuid

PORT = 2425

# IPMsg 命令字与选项位
BR_ENTRY = 0x00000001
BR_EXIT = 0x00000002
ANSENTRY = 0x00000003
BR_ABSENCE = 0x00000004
SENDMSG = 0x00000020
RECVMSG = 0x00000021
SENDCHECKOPT = 0x00000100
FILEATTACHOPT = 0x00200000
UTF8OPT = 0x00800000
CAPUTF8OPT = 0x01000000
COMMAND_MASK = 0xFF

COMMAND_NAMES = {
    BR_ENTRY: "BR_ENTRY(上线)",
    BR_EXIT: "BR_EXIT(下线)",
    ANSENTRY: "ANSENTRY(应答)",
    BR_ABSENCE: "BR_ABSENCE(状态)",
    SENDMSG: "SENDMSG(消息)",
    RECVMSG: "RECVMSG(回执)",
    0x60: "GETFILEDATA",
    0x61: "RELEASEFILES",
}


def local_mac() -> str:
    return "%012X" % uuid.getnode()


def guess_local_ip():
    """不发包地探测默认出口网卡的本机 IP(多网卡/VPN 环境下用于自检)。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("223.5.5.5", 53))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def directed_broadcast_of(ip: str):
    """按 /24 估算定向广播地址(绝大多数办公/家用网段适用)。"""
    parts = ip.split(".")
    if len(parts) != 4:
        return None
    return ".".join(parts[:3] + ["255"])


def feiq_version() -> str:
    # 飞秋版本串第 3 段必须是本机 MAC,飞秋用它作为主机标识。
    return "1_lbt6_0#128#{}#0#0#0#4001#9".format(local_mac())


# 方言 → (版本串, 传统编码)。ipmsg-utf8 走 UTF8OPT,无传统编码。
DIALECTS = {
    "ipmsg-utf8": ("1", "utf-8"),      # 官方日文 IP Messenger 4.x+(UTF-8 能力)
    "ipmsg-cn": ("1", "gbk"),          # 中文飞鸽传书:版本串同为 "1",正文 GBK
    "feiq": (feiq_version(), "gbk"),   # 飞秋
    "intranet": ("1@shiyeline", "gbk"),  # 内网通 2425 旧路径
}

_counter = int(time.time()) % 100000


def next_packet_no() -> str:
    global _counter
    _counter += 1
    return str(int(time.time())) + str(_counter % 1000)


def build_packet(dialect, command, user, host, extra, attach=b""):
    version, encoding = DIALECTS[dialect]
    if dialect == "ipmsg-utf8":
        command |= UTF8OPT | CAPUTF8OPT
    enc = "utf-8" if command & UTF8OPT else encoding
    head = ":".join([version, next_packet_no(), user, host, str(command)])
    payload = head.encode(enc, errors="replace") + b":" + extra.encode(enc, errors="replace")
    return payload + b"\x00" + attach


def try_decode(data: bytes):
    views = {}
    for name, codec in (("GBK", "gbk"), ("CP932", "cp932"), ("UTF-8", "utf-8")):
        try:
            views[name] = data.decode(codec)
        except UnicodeDecodeError:
            views[name] = None
    return views


def guess_dialect(version: str) -> str:
    if version.startswith("1_lbt"):
        return "飞秋(1_lbt*)"
    if version.startswith("1@shiyeline"):
        return "内网通(1@shiyeline)"
    if version == "1":
        return "标准 IPMsg / 中文飞鸽(版本串无法区分,看正文编码)"
    return "未知方言"


def parse_packet(data: bytes):
    """按 ver:no:user:host:cmd:extra 拆包,字段保持原始字节。"""
    fields = data.split(b":", 5)
    if len(fields) < 6:
        return None
    version = fields[0].decode("ascii", errors="replace")
    try:
        command = int(fields[4].decode("ascii"))
    except ValueError:
        return None
    body = fields[5]
    extra, _, attach = body.partition(b"\x00")
    return {
        "version": version,
        "packet_no": fields[1].decode("ascii", errors="replace"),
        "user": fields[2],
        "host": fields[3],
        "command": command,
        "extra": extra,
        "attach": attach,
    }


def describe_command(command: int) -> str:
    name = COMMAND_NAMES.get(command & COMMAND_MASK, hex(command & COMMAND_MASK))
    flags = []
    if command & UTF8OPT:
        flags.append("UTF8")
    if command & CAPUTF8OPT:
        flags.append("CAPUTF8")
    if command & SENDCHECKOPT:
        flags.append("SENDCHECK")
    if command & FILEATTACHOPT:
        flags.append("FILEATTACH")
    return name + ("(" + "|".join(flags) + ")" if flags else "")


def field_view(label: str, data: bytes, utf8: bool):
    views = try_decode(data)
    parts = []
    if utf8:
        order = ("UTF-8", "GBK", "CP932")
    else:
        order = ("GBK", "CP932", "UTF-8")
    for name in order:
        value = views[name]
        parts.append("{}={}".format(name, repr(value) if value is not None else "×"))
    return "  {:<6} {} | {}".format(label, data.hex(" "), "  ".join(parts))


def print_packet(source, packet):
    utf8 = bool(packet["command"] & UTF8OPT)
    print("─" * 72)
    print("来自 {}:{}".format(*source))
    print("  版本串 {!r} → {}".format(packet["version"], guess_dialect(packet["version"])))
    print("  命令   {} (raw={})".format(describe_command(packet["command"]), packet["command"]))
    print(field_view("user", packet["user"], utf8))
    print(field_view("host", packet["host"], utf8))
    print(field_view("extra", packet["extra"], utf8))
    if packet["attach"]:
        print(field_view("attach", packet["attach"].rstrip(b"\x00"), utf8))
    sys.stdout.flush()


def open_socket(bind_ip: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.bind((bind_ip, port))
    except OSError as error:
        if port == PORT:
            sys.exit(
                "无法绑定 UDP {}:{}: {}\n"
                "→ 本机已有程序占用 2425(飞鸽/飞秋/内网通/RocketX 之一)。\n"
                "  同一台机器上两个 2425 客户端无法共存;请换一台机器运行本工具,\n"
                "  或用 --src-port 0 改用临时端口(部分客户端只回 2425,可能收不到应答)。".format(
                    bind_ip, port, error
                )
            )
        raise
    return sock


def collect_replies(sock: socket.socket, seconds: float, on_packet):
    deadline = time.time() + seconds
    sock.settimeout(0.3)
    while time.time() < deadline:
        try:
            data, source = sock.recvfrom(65536)
        except socket.timeout:
            continue
        except OSError:
            break
        packet = parse_packet(data)
        if packet is None:
            print("─" * 72)
            print("来自 {}:{} 的报文无法按 IPMsg 语法解析: {!r}".format(source[0], source[1], data[:80]))
            continue
        on_packet(source, packet)


def cmd_listen(args):
    sock = open_socket(args.bind, args.src_port)
    print("正在监听 UDP {}:{} … Ctrl+C 退出".format(args.bind, args.src_port))
    if args.reply:
        print("(收到 BR_ENTRY 时将以 {} 方言回复 ANSENTRY)".format(args.dialect))

    def on_packet(source, packet):
        print_packet(source, packet)
        if args.reply and packet["command"] & COMMAND_MASK == BR_ENTRY:
            answer = build_packet(args.dialect, ANSENTRY, args.name, args.host_name, args.name)
            sock.sendto(answer, source)
            print("  ↳ 已回复 ANSENTRY ({})".format(args.dialect))

    try:
        collect_replies(sock, float("inf"), on_packet)
    except KeyboardInterrupt:
        print("\n结束监听")


def send_entries(sock, targets, dialects, args):
    for target in targets:
        for dialect in dialects:
            packet = build_packet(
                dialect, BR_ENTRY | FILEATTACHOPT, args.name, args.host_name, args.name
            )
            sock.sendto(packet, (target, args.port))
            print("→ 已向 {}:{} 发送 {} 方言 BR_ENTRY(版本串 {!r})".format(
                target, args.port, dialect, DIALECTS[dialect][0]
            ))
            time.sleep(0.1)


def report_answers(answers):
    print("=" * 72)
    if not answers:
        print("结果:没有收到任何 ANSENTRY 应答。")
        print("  四种方言全部无应答通常说明问题在网络层,而不是协议方言层。按顺序排查:")
        print("  1) 单播绕开广播:python ipmsg_probe.py probe <对方IP> —— 回包来自同一")
        print("     IP,Windows 防火墙一般放行;单播通而广播不通 → 广播被 AP 隔离或路由丢弃。")
        print("  2) 验证入站方向:本机运行 listen,让对方客户端刷新联系人列表(会广播")
        print("     BR_ENTRY);listen 毫无输出 → 入站被防火墙/AP 隔离拦截。")
        print("  3) Windows 防火墙对 python.exe 放行 UDP 2425 入站(广播的应答来自各主机")
        print("     的单播地址,不匹配防火墙的 UDP 状态跟踪,默认可能被丢)。")
        print("  4) 多网卡/VPN:用 --bind <本机局域网IP> 强制物理网卡,并用")
        print("     --broadcast x.y.z.255 定向广播。")
        return
    print("结果:收到 {} 个应答".format(len(answers)))
    for (ip, version), nickname in sorted(answers.items()):
        print("  {}  版本串 {!r} → {}  昵称 {}".format(ip, version, guess_dialect(version), nickname))


def cmd_probe(args):
    sock = open_socket(args.bind, args.src_port)
    dialects = args.dialects.split(",")
    answers = {}
    print_network_hint(args)

    def on_packet(source, packet):
        print_packet(source, packet)
        if packet["command"] & COMMAND_MASK == ANSENTRY:
            views = try_decode(packet["extra"])
            nickname = views["UTF-8"] if packet["command"] & UTF8OPT else (views["GBK"] or views["CP932"])
            answers[(source[0], packet["version"])] = nickname

    send_entries(sock, args.targets, dialects, args)
    print("等待应答 {} 秒 …".format(args.wait))
    collect_replies(sock, args.wait, on_packet)
    report_answers(answers)


def print_network_hint(args):
    ip = guess_local_ip()
    print("本机默认出口 IP:{}(绑定 {}:{})".format(ip or "未知", args.bind, args.src_port))
    if ip and args.bind == "0.0.0.0":
        print("  多网卡/VPN 环境建议加 --bind {} 强制走物理网卡".format(ip))
    return ip


def cmd_announce(args):
    sock = open_socket(args.bind, args.src_port)
    dialects = args.dialects.split(",")
    answers = {}
    local = print_network_hint(args)

    def on_packet(source, packet):
        print_packet(source, packet)
        if packet["command"] & COMMAND_MASK == ANSENTRY:
            views = try_decode(packet["extra"])
            nickname = views["UTF-8"] if packet["command"] & UTF8OPT else (views["GBK"] or views["CP932"])
            answers[(source[0], packet["version"])] = nickname

    targets = [args.broadcast]
    if args.broadcast == "255.255.255.255" and local:
        directed = directed_broadcast_of(local)
        if directed and directed not in targets:
            # 部分路由器/驱动会丢 255.255.255.255,同时补发 /24 定向广播
            targets.append(directed)
    send_entries(sock, targets, dialects, args)
    print("等待全网应答 {} 秒 …".format(args.wait))
    collect_replies(sock, args.wait, on_packet)
    report_answers(answers)


def cmd_send(args):
    sock = open_socket(args.bind, args.src_port)
    packet_no = next_packet_no()
    version, encoding = DIALECTS[args.dialect]
    command = SENDMSG | SENDCHECKOPT
    if args.dialect == "ipmsg-utf8":
        command |= UTF8OPT
    enc = "utf-8" if command & UTF8OPT else encoding
    head = ":".join([version, packet_no, args.name, args.host_name, str(command)])
    data = head.encode(enc, errors="replace") + b":" + args.text.encode(enc, errors="replace") + b"\x00"
    got_receipt = []

    def on_packet(source, packet):
        print_packet(source, packet)
        if packet["command"] & COMMAND_MASK == RECVMSG and packet["extra"].decode(
            "ascii", errors="replace"
        ).strip("\x00").strip() == packet_no:
            got_receipt.append(source)

    print("→ 以 {} 方言向 {}:{} 发送消息(packet_no={})".format(args.dialect, args.target, args.port, packet_no))
    sock.sendto(data, (args.target, args.port))
    collect_replies(sock, args.wait, on_packet)
    print("=" * 72)
    if got_receipt:
        print("结果:对方已确认收到(RECVMSG 回执匹配)。")
    else:
        print("结果:{} 秒内未收到 RECVMSG 回执 —— 对方没收到、丢弃了报文,或不回执。".format(args.wait))


def main():
    parser = argparse.ArgumentParser(
        description="飞鸽/飞秋/内网通 2425 协议探测器", formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--name", default="rcx-probe", help="宣告用的用户名/昵称(默认 rcx-probe)")
    parser.add_argument("--host-name", default=socket.gethostname() or "probe-host", help="宣告用的主机名")
    parser.add_argument("--bind", default="0.0.0.0", help="本地绑定地址(默认 0.0.0.0)")
    parser.add_argument("--src-port", type=int, default=PORT, help="本地源端口(默认 2425;0=临时端口)")
    parser.add_argument("--port", type=int, default=PORT, help="目标端口(默认 2425)")

    sub = parser.add_subparsers(dest="command", required=True)

    listen = sub.add_parser("listen", help="监听并解码 2425 流量")
    listen.add_argument("--reply", action="store_true", help="收到 BR_ENTRY 时自动回复 ANSENTRY")
    listen.add_argument("--dialect", default="ipmsg-utf8", choices=DIALECTS, help="自动回复使用的方言")
    listen.set_defaults(func=cmd_listen)

    probe = sub.add_parser("probe", help="向指定目标逐方言发送上线宣告")
    probe.add_argument("targets", nargs="+", help="目标 IP(可多个)")
    probe.add_argument("--dialects", default=",".join(DIALECTS), help="要测试的方言,逗号分隔")
    probe.add_argument("--wait", type=float, default=5.0, help="等待应答秒数")
    probe.set_defaults(func=cmd_probe)

    announce = sub.add_parser("announce", help="向广播地址宣告并收集全网应答")
    announce.add_argument("--broadcast", default="255.255.255.255", help="广播地址(跨网段可改定向广播)")
    announce.add_argument("--dialects", default=",".join(DIALECTS), help="要测试的方言,逗号分隔")
    announce.add_argument("--wait", type=float, default=8.0, help="等待应答秒数")
    announce.set_defaults(func=cmd_announce)

    send = sub.add_parser("send", help="发送一条消息并等待回执")
    send.add_argument("target", help="目标 IP")
    send.add_argument("text", help="消息内容")
    send.add_argument("--dialect", default="ipmsg-utf8", choices=DIALECTS, help="发送方言")
    send.add_argument("--wait", type=float, default=5.0, help="等待回执秒数")
    send.set_defaults(func=cmd_send)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
