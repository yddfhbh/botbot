import argparse
import json
from pathlib import Path

import cv2
import mss
import numpy as np


WINDOW_NAME = "cold-clear-calibrator"
DEFAULT_OUTPUT = "automation/scan-config.json"
DEFAULT_PALETTE = {
    "I": [66, 226, 255],
    "O": [255, 211, 70],
    "T": [178, 102, 255],
    "L": [255, 153, 51],
    "J": [92, 121, 255],
    "S": [102, 230, 102],
    "Z": [255, 94, 94],
}


class CalibratorState:
    def __init__(self, output_path, monitor_index, player_side):
        self.output_path = Path(output_path)
        self.monitor_index = monitor_index
        self.player_side = player_side
        self.mode = "board"
        self.drag_start = None
        self.drag_rect = None
        self.capture_region = None
        self.board = None
        self.hold_slot = None
        self.active_slot = None
        self.spawn_zone = None
        self.queue_slots = [None, None, None, None, None]

    def assign_rect(self, rect):
        if rect[2] <= 2 or rect[3] <= 2:
            return
        if self.mode == "board":
            self.board = rect
        elif self.mode == "hold":
            self.hold_slot = rect
        elif self.mode == "active":
            self.active_slot = rect
        elif self.mode == "spawn":
            self.spawn_zone = rect
        elif self.mode.startswith("queue"):
            index = int(self.mode[-1]) - 1
            self.queue_slots[index] = rect

    def to_config(self):
        if self.board is None:
            raise ValueError("board rectangle is required before saving")

        board_x, board_y, board_w, board_h = self.board
        config = {
            "output_path": "automation/live-snapshot.json",
            "poll_interval_ms": 16,
            "spawn_stability_frames": 2,
            "monitor_index": self.monitor_index,
            "piece_palette": DEFAULT_PALETTE,
            "piece_detection": {
                "background_rgb": [0, 0, 0],
                "background_distance_threshold": 45,
                "piece_match_threshold": 95,
                "min_pixels": 50,
            },
            "board": {
                "x": board_x,
                "y": board_y,
                "w": board_w,
                "h": board_h,
                "visible_rows": 20,
                "visible_cols": 10,
                "sample_inset": 0.32,
                "empty_rgb": [0, 0, 0],
                "occupancy_threshold": 55,
                "trim_disconnected": True,
            },
            "queue_slots": [
                {"x": x, "y": y, "w": w, "h": h}
                for slot in self.queue_slots
                if slot is not None
                for (x, y, w, h) in [slot]
            ],
            "debug_output_path": "automation/scanner-debug.png",
            "active_spawn": {
                "enabled": True,
                "cols_left": 3.0,
                "cols_width": 4.0,
                "rows_above": 3.2,
                "rows_inside": 1.2,
            },
        }
        if self.hold_slot is not None:
            x, y, w, h = self.hold_slot
            config["hold_slot"] = {"x": x, "y": y, "w": w, "h": h}
        if self.active_slot is not None:
            x, y, w, h = self.active_slot
            config["active_slot"] = {"x": x, "y": y, "w": w, "h": h}
        if self.spawn_zone is not None:
            x, y, w, h = self.spawn_zone
            config["spawn_zone"] = {"x": x, "y": y, "w": w, "h": h}
        return config

    def apply_layout(self, layout):
        self.board = layout["board"]
        self.hold_slot = layout["hold_slot"]
        self.active_slot = layout.get("active_slot")
        self.spawn_zone = layout["spawn_zone"]
        self.queue_slots = layout["queue_slots"][:]


def normalize_rect(x1, y1, x2, y2):
    left = min(x1, x2)
    top = min(y1, y2)
    width = abs(x2 - x1)
    height = abs(y2 - y1)
    return (left, top, width, height)


def draw_rect(frame, rect, color, label):
    if rect is None:
        return
    x, y, w, h = rect
    cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
    cv2.putText(
        frame,
        label,
        (x, max(20, y - 8)),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        color,
        2,
        cv2.LINE_AA,
    )


def clamp_rect(frame_shape, rect):
    height, width = frame_shape[:2]
    x, y, w, h = rect
    x = max(0, min(width - 1, int(round(x))))
    y = max(0, min(height - 1, int(round(y))))
    w = max(1, min(width - x, int(round(w))))
    h = max(1, min(height - y, int(round(h))))
    return (x, y, w, h)


def count_profile_peaks(profile, threshold, min_gap):
    peaks = []
    idx = 0
    profile_len = len(profile)
    while idx < profile_len:
        if profile[idx] < threshold:
            idx += 1
            continue

        start = idx
        best_idx = idx
        best_value = profile[idx]
        while idx < profile_len and profile[idx] >= threshold:
            if profile[idx] > best_value:
                best_idx = idx
                best_value = profile[idx]
            idx += 1

        if not peaks or best_idx - peaks[-1] >= min_gap:
            peaks.append(best_idx)
        elif profile[peaks[-1]] < best_value:
            peaks[-1] = best_idx
        idx = max(idx, start + 1)
    return peaks


def estimate_grid_features(gray_crop):
    edges = cv2.Canny(gray_crop, 60, 160)
    vertical_profile = edges.mean(axis=0)
    horizontal_profile = edges.mean(axis=1)

    vertical_threshold = max(18.0, float(vertical_profile.mean() + vertical_profile.std() * 1.15))
    horizontal_threshold = max(
        18.0, float(horizontal_profile.mean() + horizontal_profile.std() * 1.00)
    )

    vertical_peaks = count_profile_peaks(
        vertical_profile,
        vertical_threshold,
        max(2, gray_crop.shape[1] // 18),
    )
    horizontal_peaks = count_profile_peaks(
        horizontal_profile,
        horizontal_threshold,
        max(2, gray_crop.shape[0] // 28),
    )
    edge_density = float((edges > 0).mean())
    return {
        "vertical_peaks": len(vertical_peaks),
        "horizontal_peaks": len(horizontal_peaks),
        "edge_density": edge_density,
    }


def derive_layout_from_board(frame_shape, board_rect):
    board_x, board_y, board_w, board_h = board_rect

    hold_panel = clamp_rect(
        frame_shape,
        (
            board_x - board_w * 0.515,
            board_y,
            board_w * 0.49,
            board_h * 0.20,
        ),
    )
    hold_slot = clamp_rect(
        frame_shape,
        (
            hold_panel[0] + hold_panel[2] * 0.12,
            hold_panel[1] + hold_panel[3] * 0.30,
            hold_panel[2] * 0.74,
            hold_panel[3] * 0.56,
        ),
    )

    next_panel = clamp_rect(
        frame_shape,
        (
            board_x + board_w * 1.03,
            board_y,
            board_w * 0.50,
            board_h * 0.79,
        ),
    )
    queue_slots = []
    slot_height = next_panel[3] * 0.145
    for index in range(5):
        slot_y = next_panel[1] + next_panel[3] * (0.09 + index * 0.18)
        queue_slots.append(
            clamp_rect(
                frame_shape,
                (
                    next_panel[0] + next_panel[2] * 0.12,
                    slot_y,
                    next_panel[2] * 0.76,
                    slot_height,
                ),
            )
        )

    spawn_zone = clamp_rect(
        frame_shape,
        (
            board_x + board_w * 0.30,
            board_y - board_h * 0.16,
            board_w * 0.40,
            board_h * 0.22,
        ),
    )

    return {
        "board": board_rect,
        "hold_slot": hold_slot,
        "active_slot": None,
        "spawn_zone": spawn_zone,
        "queue_slots": queue_slots,
    }


def detect_board_candidates(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    frame_h, frame_w = gray.shape[:2]
    frame_area = frame_h * frame_w
    candidates = []

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    for threshold in (135, 165, 195):
        dark_mask = cv2.inRange(gray, 0, threshold)
        dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        dark_mask = cv2.morphologyEx(dark_mask, cv2.MORPH_OPEN, kernel, iterations=1)

        contours, _ = cv2.findContours(dark_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            area = w * h
            if area < frame_area * 0.012:
                continue
            if h < frame_h * 0.24:
                continue
            aspect = w / float(h)
            if not 0.22 <= aspect <= 0.82:
                continue

            crop = gray[y : y + h, x : x + w]
            dark_ratio = float((crop < min(threshold + 10, 220)).mean())
            if dark_ratio < 0.18:
                continue

            grid = estimate_grid_features(crop)
            if grid["vertical_peaks"] < 6 or grid["horizontal_peaks"] < 10:
                continue

            score = (
                area * (0.2 + dark_ratio)
                + 7000 * min(grid["vertical_peaks"], 12)
                + 4500 * min(grid["horizontal_peaks"], 22)
                + 180000 * grid["edge_density"]
            )
            candidates.append(
                {
                    "rect": (x, y, w, h),
                    "score": score,
                    "area": area,
                    "center_x": x + w / 2.0,
                    "dark_ratio": dark_ratio,
                    "grid": grid,
                }
            )

    deduped = []
    for candidate in sorted(candidates, key=lambda item: item["score"], reverse=True):
        x, y, w, h = candidate["rect"]
        keep = True
        for existing in deduped:
            ex, ey, ew, eh = existing["rect"]
            if (
                abs(x - ex) <= 18
                and abs(y - ey) <= 18
                and abs(w - ew) <= 24
                and abs(h - eh) <= 24
            ):
                keep = False
                break
        if keep:
            deduped.append(candidate)
    return deduped


def auto_detect_layout(frame, player_side):
    candidates = detect_board_candidates(frame)
    if not candidates:
        raise RuntimeError("could not detect a TETR.IO board automatically")

    max_area = max(candidate["area"] for candidate in candidates)
    large_candidates = [
        candidate for candidate in candidates if candidate["area"] >= max_area * 0.82
    ]

    if player_side == "right":
        chosen = max(large_candidates, key=lambda candidate: candidate["center_x"])
    elif player_side == "left":
        chosen = min(large_candidates, key=lambda candidate: candidate["center_x"])
    else:
        if len(large_candidates) >= 2:
            chosen = min(large_candidates, key=lambda candidate: candidate["center_x"])
        else:
            chosen = max(large_candidates, key=lambda candidate: candidate["score"])

    layout = derive_layout_from_board(frame.shape, chosen["rect"])
    return layout, candidates


def save_config(state):
    config = state.to_config()
    state.output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(state.output_path, "w", encoding="utf-8") as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
    print(f"[calibrator] saved {state.output_path}")


def main():
    parser = argparse.ArgumentParser(description="Interactive region picker for the Cold Clear screen scanner.")
    parser.add_argument("--monitor", type=int, default=1, help="1-based monitor index used by mss")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Where to save the scanner config")
    parser.add_argument(
        "--player-side",
        choices=["auto", "left", "right"],
        default="auto",
        help="Which detected board to prefer when multiple boards are visible",
    )
    parser.add_argument(
        "--auto-save",
        action="store_true",
        help="Detect the layout once, save the config, and exit without opening the UI",
    )
    args = parser.parse_args()

    state = CalibratorState(args.output, args.monitor, args.player_side)

    with mss.MSS() as sct:
        monitor = sct.monitors[args.monitor]
        region = {
            "left": monitor["left"],
            "top": monitor["top"],
            "width": monitor["width"],
            "height": monitor["height"],
        }

        initial_frame = np.array(sct.grab(region))[:, :, :3][:, :, ::-1].copy()
        auto_detect_ok = False
        try:
            layout, _candidates = auto_detect_layout(initial_frame, state.player_side)
            state.apply_layout(layout)
            print(f"[calibrator] auto-detected board={state.board}")
            auto_detect_ok = True
        except Exception as exc:
            print(f"[calibrator] auto-detect failed: {exc}")

        if args.auto_save:
            if not auto_detect_ok:
                print(
                    "[calibrator] auto-save requested but board detection failed. "
                    "Run without --auto-save and press r or adjust manually."
                )
                raise SystemExit(1)
            save_config(state)
            return

        def on_mouse(event, x, y, _flags, _userdata):
            if event == cv2.EVENT_LBUTTONDOWN:
                state.drag_start = (x, y)
                state.drag_rect = None
            elif event == cv2.EVENT_MOUSEMOVE and state.drag_start is not None:
                state.drag_rect = normalize_rect(state.drag_start[0], state.drag_start[1], x, y)
            elif event == cv2.EVENT_LBUTTONUP and state.drag_start is not None:
                state.drag_rect = normalize_rect(state.drag_start[0], state.drag_start[1], x, y)
                state.assign_rect(state.drag_rect)
                state.drag_start = None

        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
        cv2.setMouseCallback(WINDOW_NAME, on_mouse)

        while True:
            frame = np.array(sct.grab(region))[:, :, :3][:, :, ::-1].copy()
            overlay = frame.copy()

            draw_rect(overlay, state.board, (0, 255, 0), "board")
            draw_rect(overlay, state.hold_slot, (255, 200, 0), "hold")
            draw_rect(overlay, state.active_slot, (0, 200, 255), "active")
            draw_rect(overlay, state.spawn_zone, (0, 255, 255), "spawn")
            for index, slot in enumerate(state.queue_slots, start=1):
                draw_rect(overlay, slot, (255, 0, 255), f"q{index}")
            draw_rect(overlay, state.drag_rect, (255, 255, 255), f"drag:{state.mode}")

            help_lines = [
                "r=auto-detect  b=board  h=hold  a=active  p=spawn  1..5=queue slots",
                "drag with mouse to assign current mode",
                "s=save config  q=quit",
                f"mode={state.mode} output={state.output_path}",
            ]
            y = 28
            for line in help_lines:
                cv2.putText(
                    overlay,
                    line,
                    (12, y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA,
                )
                y += 28

            cv2.imshow(WINDOW_NAME, cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
            key = cv2.waitKey(16) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                try:
                    layout, _candidates = auto_detect_layout(frame, state.player_side)
                    state.apply_layout(layout)
                    print(f"[calibrator] auto-detected board={state.board}")
                except Exception as exc:
                    print(f"[calibrator] auto-detect failed: {exc}")
            elif key == ord("b"):
                state.mode = "board"
            elif key == ord("h"):
                state.mode = "hold"
            elif key == ord("a"):
                state.mode = "active"
            elif key == ord("p"):
                state.mode = "spawn"
            elif key in (ord("1"), ord("2"), ord("3"), ord("4"), ord("5")):
                state.mode = f"queue{chr(key)}"
            elif key == ord("s"):
                try:
                    save_config(state)
                except Exception as exc:
                    print(f"[calibrator] save failed: {exc}")

        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
