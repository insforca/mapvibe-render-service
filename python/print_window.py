"""Centre a visible poster rectangle inside a larger print sheet.

Canvas print files (21x27 in, 27x39 in, …) are bigger than the product the
customer composed. The editor bounds are that visible window. Growing both
axes about the centre by print/visible puts extra map in the wrap and does
not crop the framed area.

No network. No vendor clients.
"""


def expand_projected_window(x0, x1, y0, y1, print_w_in, print_h_in,
                            visible_w_in=None, visible_h_in=None):
    if visible_w_in is None or visible_h_in is None:
        return (x0, x1, y0, y1)
    try:
        pw = float(print_w_in)
        ph = float(print_h_in)
        vw = float(visible_w_in)
        vh = float(visible_h_in)
    except (TypeError, ValueError):
        return (x0, x1, y0, y1)
    if pw <= 0 or ph <= 0 or vw <= 0 or vh <= 0:
        return (x0, x1, y0, y1)
    if vw < pw - 1e-6:
        span = x1 - x0
        want = span * (pw / vw)
        pad = (want - span) / 2.0
        x0 -= pad
        x1 += pad
    if vh < ph - 1e-6:
        span = y1 - y0
        want = span * (ph / vh)
        pad = (want - span) / 2.0
        y0 -= pad
        y1 += pad
    return (x0, x1, y0, y1)


def _self_test() -> None:
    x0, x1, y0, y1 = expand_projected_window(0, 18, 0, 24, 21, 27, 18, 24)
    assert abs(x0 - -1.5) < 1e-6, x0
    assert abs(x1 - 19.5) < 1e-6, x1
    assert abs(y0 - -1.5) < 1e-6, y0
    assert abs(y1 - 25.5) < 1e-6, y1
    assert abs((x1 - x0) / (y1 - y0) - (21 / 27)) < 1e-6
    assert expand_projected_window(0, 18, 0, 24, 18, 24, 18, 24) == (0, 18, 0, 24)
    assert expand_projected_window(0, 18, 0, 24, 21, 27, None, None) == (0, 18, 0, 24)
    # 24x36 canvas print area is 27x39. Visible window stays centred.
    x0, x1, y0, y1 = expand_projected_window(0, 24, 0, 36, 27, 39, 24, 36)
    assert abs((x1 - x0) - 27) < 1e-6
    assert abs((y1 - y0) - 39) < 1e-6
    assert abs(((x0 + x1) / 2) - 12) < 1e-6
    assert abs(((y0 + y1) / 2) - 18) < 1e-6
    print('ok')


if __name__ == '__main__':
    import sys
    if '--self-test' in sys.argv:
        _self_test()
    else:
        sys.stderr.write('print_window.py is a library. Pass --self-test.\n')
        sys.exit(2)
