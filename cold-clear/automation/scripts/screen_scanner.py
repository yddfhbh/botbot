import argparse
import hashlib
import json
import os
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import cv2
import mss
import numpy as np


PIECES = "IJLOSTZ"
VISIBLE_FIELD_PIECES = set(PIECES)
DEFAULT_PALETTE = {
    "I": [66, 175, 225],
    "J": [17, 101, 181],
    "L": [243, 137, 39],
    "O": [246, 208, 60],
    "S": [81, 184, 77],
    "T": [151, 57, 162],
    "Z": [235, 79, 101],
    "G": [134, 134, 134],
    "ghost": [221, 221, 221],
    "empty": [0, 0, 0],
}
PREVIEW_SHAPE_TEMPLATES = {
    "J": [[1, 0, 0], [1, 1, 1]],
    "L": [[0, 0, 1], [1, 1, 1]],
    "S": [[0, 1, 1], [1, 1, 0]],
    "T": [[0, 1, 0], [1, 1, 1]],
    "Z": [[1, 1, 0], [0, 1, 1]],
}
TETROMINO_BASE_COORDS = {
    "I": [(0, 0), (0, 1), (0, 2), (0, 3)],
    "J": [(0, 0), (1, 0), (1, 1), (1, 2)],
    "L": [(0, 2), (1, 0), (1, 1), (1, 2)],
    "O": [(0, 0), (0, 1), (1, 0), (1, 1)],
    "S": [(0, 1), (0, 2), (1, 0), (1, 1)],
    "T": [(0, 1), (1, 0), (1, 1), (1, 2)],
    "Z": [(0, 0), (0, 1), (1, 1), (1, 2)],
}


def normalize_coords(coords):
    min_r = min(r for r, _ in coords)
    min_c = min(c for _, c in coords)
    return tuple(sorted((r - min_r, c - min_c) for r, c in coords))


def rotate_coords(coords):
    return [(-c, r) for r, c in coords]


def build_tetromino_shape_signatures():
    signatures = {}
    for piece, coords in TETROMINO_BASE_COORDS.items():
        variants = set()
        rotated = list(coords)
        for _ in range(4):
            variants.add(normalize_coords(rotated))
            rotated = rotate_coords(rotated)
        signatures[piece] = variants
    return signatures


TETROMINO_SHAPE_SIGNATURES = build_tetromino_shape_signatures()


@dataclass
class Rect:
    x: int
    y: int
    w: int
    h: int

    @classmethod
    def from_dict(cls, raw):
        return cls(int(raw["x"]), int(raw["y"]), int(raw["w"]), int(raw["h"]))

    def crop(self, frame):
        return frame[self.y : self.y + self.h, self.x : self.x + self.w]

    def as_xyxy(self):
        return (self.x, self.y), (self.x + self.w, self.y + self.h)


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def ensure_defaults(config):
    config.setdefault("output_path", "automation/live-snapshot.json")
    config.setdefault("poll_interval_ms", 16)
    config.setdefault("spawn_stability_frames", 2)
    config.setdefault("monitor_index", 1)
    config.setdefault("piece_palette", DEFAULT_PALETTE)

    recognition = config.setdefault("recognition", {})
    recognition.setdefault("field_threshold", 60)
    recognition.setdefault("box_threshold", 95)
    recognition.setdefault("empty_brightness", 35)
    recognition.setdefault("center_sample_ratio", 0.42)
    recognition.setdefault("top_spawn_sample_ratio", 0.52)
    recognition.setdefault("top_spawn_y_bias", 0.38)
    recognition.setdefault("remove_center_overlay_artifacts", True)

    piece_detection = config.setdefault("piece_detection", {})
    piece_detection.setdefault("background_rgb", [0, 0, 0])
    piece_detection.setdefault("background_distance_threshold", 45)
    piece_detection.setdefault("piece_match_threshold", recognition["box_threshold"])
    piece_detection.setdefault("min_pixels", 50)

    board = config.setdefault("board", {})
    board.setdefault("visible_rows", 20)
    board.setdefault("visible_cols", 10)
    board.setdefault("sample_inset", 0.32)
    board.setdefault("empty_rgb", [0, 0, 0])
    board.setdefault("occupancy_threshold", 55)
    board.setdefault("trim_disconnected", True)

    active_spawn = config.setdefault("active_spawn", {})
    active_spawn.setdefault("enabled", True)
    active_spawn.setdefault("cols_left", 3.0)
    active_spawn.setdefault("cols_width", 4.0)
    active_spawn.setdefault("rows_above", 3.2)
    active_spawn.setdefault("rows_inside", 1.2)

    active_detection = config.setdefault("active_detection", {})
    active_detection.setdefault("prefer_explicit_regions", True)
    active_detection.setdefault("prefer_shape_for_explicit_regions", True)
    return config


def capture_region_for_monitor(sct, config):
    mon = sct.monitors[int(config["monitor_index"])]
    region = config.get("capture_region")
    if not region:
        return {
            "left": mon["left"],
            "top": mon["top"],
            "width": mon["width"],
            "height": mon["height"],
        }
    return {
        "left": mon["left"] + int(region["x"]),
        "top": mon["top"] + int(region["y"]),
        "width": int(region["w"]),
        "height": int(region["h"]),
    }


def grab_frame(sct, region):
    raw = np.array(sct.grab(region))
    return raw[:, :, :3][:, :, ::-1].copy()


def crop_region(img, region):
    return Rect.from_dict(region).crop(img)


def get_inner_crop(img, ratio=0.42, x_bias=0.0, y_bias=0.0):
    h, w = img.shape[:2]
    ratio = max(0.1, min(1.0, ratio))
    inner_w = int(w * ratio)
    inner_h = int(h * ratio)
    margin_x = max(0, w - inner_w)
    margin_y = max(0, h - inner_h)
    x_bias = max(-1.0, min(1.0, x_bias))
    y_bias = max(-1.0, min(1.0, y_bias))
    x1 = int(round(margin_x * (0.5 + 0.5 * x_bias)))
    y1 = int(round(margin_y * (0.5 + 0.5 * y_bias)))
    x2 = min(w, x1 + inner_w)
    y2 = min(h, y1 + inner_h)
    return img[y1:y2, x1:x2]


def average_rgb(img):
    if img.size == 0:
        return [0.0, 0.0, 0.0]
    avg = img.reshape(-1, 3).mean(axis=0)
    return [float(avg[0]), float(avg[1]), float(avg[2])]


def rgb_distance(c1, c2):
    return float(np.linalg.norm(np.array(c1, dtype=np.float32) - np.array(c2, dtype=np.float32)))


def color_spread(rgb):
    return float(max(rgb) - min(rgb))


def is_probable_colored_ghost(rgb, target_rgb, recog):
    observed_brightness = sum(rgb) / 3.0
    target_brightness = sum(target_rgb) / 3.0
    if target_brightness <= 0:
        return False
    observed_spread = color_spread(rgb)
    target_spread = color_spread(target_rgb)
    brightness_ratio = observed_brightness / target_brightness
    spread_ratio = observed_spread / target_spread if target_spread > 0 else 1.0
    return (
        brightness_ratio <= recog.get("ghost_piece_brightness_ratio", 0.78)
        and spread_ratio <= recog.get("ghost_piece_spread_ratio", 0.72)
    )


def classify_color(rgb, palette, threshold, recog, detect_colored_ghost=False):
    if sum(rgb) / 3.0 < recog.get("empty_brightness", 35):
        return "empty"

    best_piece = "empty"
    best_dist = 1e9
    for piece, target in palette.items():
        dist = rgb_distance(rgb, target)
        if dist < best_dist:
            best_dist = dist
            best_piece = piece

    if best_dist > threshold:
        return "empty"

    if detect_colored_ghost and best_piece not in ("empty", "ghost", "G"):
        if is_probable_colored_ghost(rgb, palette[best_piece], recog):
            return "ghost"

    return best_piece


def build_preview_mask(img):
    if img.size == 0:
        return np.zeros((0, 0), dtype=np.uint8)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, mask = cv2.threshold(blurred, 52, 255, cv2.THRESH_BINARY)
    kernel = np.ones((3, 3), dtype=np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    return mask


def largest_component(mask, min_area=80):
    if mask.size == 0:
        return None
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if count <= 1:
        return None
    best = None
    best_area = 0
    for idx in range(1, count):
        x, y, w, h, area = stats[idx]
        if area < min_area or area <= best_area:
            continue
        best = (idx, x, y, w, h, area)
        best_area = area
    if best is None:
        return None
    idx, x, y, w, h, _ = best
    return (labels[y : y + h, x : x + w] == idx).astype(np.uint8)


def make_occupancy_grid(mask, rows, cols, threshold=0.2):
    if mask is None or mask.size == 0:
        return None
    h, w = mask.shape
    grid = []
    for r in range(rows):
        row = []
        for c in range(cols):
            y1 = int(r * h / rows)
            y2 = int((r + 1) * h / rows)
            x1 = int(c * w / cols)
            x2 = int((c + 1) * w / cols)
            cell = mask[y1:y2, x1:x2]
            filled = float(cell.mean()) if cell.size else 0.0
            row.append(1 if filled >= threshold else 0)
        grid.append(row)
    return grid


def classify_preview_by_shape(img):
    mask = build_preview_mask(img)
    component = largest_component(mask)
    if component is None:
        return None
    h, w = component.shape
    if h == 0 or w == 0:
        return None
    aspect = w / h
    if aspect >= 2.2:
        return "I"
    grid_2x2 = make_occupancy_grid(component, 2, 2, threshold=0.28)
    if 0.8 <= aspect <= 1.25 and grid_2x2 == [[1, 1], [1, 1]]:
        return "O"
    grid_2x3 = make_occupancy_grid(component, 2, 3, threshold=0.22)
    if grid_2x3 is None:
        return None
    best_piece = None
    best_score = -1
    for piece, template in PREVIEW_SHAPE_TEMPLATES.items():
        score = 0
        for r in range(2):
            for c in range(3):
                if grid_2x3[r][c] == template[r][c]:
                    score += 1
        if score > best_score:
            best_piece = piece
            best_score = score
    return best_piece if best_score >= 5 else None


def classify_slot_piece(frame, slot_cfg, palette, config, prefer_shape=True):
    rect = Rect.from_dict(slot_cfg)
    crop = rect.crop(frame)
    if crop.size == 0:
        return None, {"reason": "empty-crop"}

    recog = config["recognition"]
    detect_cfg = config["piece_detection"]
    threshold = detect_cfg.get("piece_match_threshold", recog["box_threshold"])
    inner = get_inner_crop(crop, recog.get("center_sample_ratio", 0.42))
    avg_rgb = average_rgb(inner)
    color_piece = classify_color(avg_rgb, palette, threshold, recog)
    shape_piece = classify_preview_by_shape(crop)

    piece = None
    if prefer_shape:
        piece = shape_piece or (color_piece if color_piece in PIECES else None)
    else:
        piece = (color_piece if color_piece in PIECES else None) or shape_piece

    return piece, {
        "avg_rgb": [round(v, 1) for v in avg_rgb],
        "shape_piece": shape_piece,
        "color_piece": color_piece,
    }


def component_cells(board, target_filter):
    rows = len(board)
    cols = len(board[0]) if rows else 0
    visited = [[False for _ in range(cols)] for _ in range(rows)]
    components = []
    for r in range(rows):
        for c in range(cols):
            if visited[r][c]:
                continue
            piece = board[r][c]
            if not target_filter(piece):
                continue
            stack = [(r, c)]
            visited[r][c] = True
            cells = []
            while stack:
                cr, cc = stack.pop()
                cells.append((cr, cc))
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr = cr + dr
                    nc = cc + dc
                    if nr < 0 or nr >= rows or nc < 0 or nc >= cols:
                        continue
                    if visited[nr][nc]:
                        continue
                    if not target_filter(board[nr][nc]):
                        continue
                    visited[nr][nc] = True
                    stack.append((nr, nc))
            components.append(cells)
    return components


def normalize_mixed_tetromino_components(board):
    cleaned = [row[:] for row in board]
    for cells in component_cells(cleaned, lambda piece: piece in VISIBLE_FIELD_PIECES):
        if len(cells) != 4:
            continue
        piece_counts = {}
        for r, c in cells:
            piece_counts[cleaned[r][c]] = piece_counts.get(cleaned[r][c], 0) + 1
        if len(piece_counts) != 2:
            continue
        majority_piece, majority_count = max(piece_counts.items(), key=lambda item: item[1])
        minority_piece, minority_count = min(piece_counts.items(), key=lambda item: item[1])
        if majority_count < 3 or minority_count != 1:
            continue
        if majority_piece not in TETROMINO_SHAPE_SIGNATURES:
            continue
        signature = normalize_coords(cells)
        if signature not in TETROMINO_SHAPE_SIGNATURES[majority_piece]:
            continue
        if minority_piece == majority_piece:
            continue
        for r, c in cells:
            cleaned[r][c] = majority_piece
    return cleaned


def build_component_info(cells):
    return {
        "cells": cells,
        "count": len(cells),
        "min_r": min(r for r, _ in cells),
        "max_r": max(r for r, _ in cells),
        "min_c": min(c for _, c in cells),
        "max_c": max(c for _, c in cells),
    }


def component_has_support(component, board):
    rows = len(board)
    component_set = set(component["cells"])
    bottom_by_col = {}
    for r, c in component["cells"]:
        if c not in bottom_by_col or r > bottom_by_col[c]:
            bottom_by_col[c] = r
    for c, r in bottom_by_col.items():
        if r >= rows - 1:
            return True
        if board[r + 1][c] in VISIBLE_FIELD_PIECES and (r + 1, c) not in component_set:
            return True
        if board[r + 1][c] == "X":
            return True
    return False


def remove_center_overlay_artifacts(board, config):
    recog = config["recognition"]
    if recog.get("remove_center_overlay_artifacts", True) is False:
        return board
    rows = len(board)
    cols = len(board[0]) if rows else 0
    if rows == 0 or cols == 0:
        return board
    top_spawn_max_row = int(recog.get("overlay_top_spawn_max_row", 1))
    zone_top = int(round(rows * recog.get("overlay_ignore_top_ratio", 0.18)))
    zone_bottom = int(round(rows * recog.get("overlay_ignore_bottom_ratio", 0.82))) - 1
    zone_left = int(round(cols * recog.get("overlay_ignore_left_ratio", 0.2)))
    zone_right = int(round(cols * recog.get("overlay_ignore_right_ratio", 0.8))) - 1
    max_component_cells = int(recog.get("overlay_ignore_max_cells", 6))
    components = [build_component_info(cells) for cells in component_cells(board, lambda piece: piece in VISIBLE_FIELD_PIECES)]
    if len(components) < 2:
        return board
    if not any(comp["min_r"] <= top_spawn_max_row for comp in components):
        return board
    cleaned = [row[:] for row in board]
    removed_any = False
    for component in components:
        if component["min_r"] <= top_spawn_max_row:
            continue
        if component["count"] > max_component_cells:
            continue
        if component["min_r"] < zone_top or component["max_r"] > zone_bottom:
            continue
        if component["min_c"] < zone_left or component["max_c"] > zone_right:
            continue
        if component_has_support(component, cleaned):
            continue
        for r, c in component["cells"]:
            cleaned[r][c] = "."
        removed_any = True
    return normalize_mixed_tetromino_components(cleaned) if removed_any else board


def guess_active_piece(board):
    if not board:
        return None
    rows = len(board)
    cols = len(board[0]) if rows else 0
    active_search_bottom = max(0, rows - 5)
    visited = [[False for _ in range(cols)] for _ in range(rows)]
    candidates = []
    for r in range(active_search_bottom):
        for c in range(cols):
            if visited[r][c]:
                continue
            piece = board[r][c]
            if piece not in VISIBLE_FIELD_PIECES:
                continue
            stack = [(r, c)]
            visited[r][c] = True
            cells = []
            while stack:
                cr, cc = stack.pop()
                cells.append((cr, cc))
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr = cr + dr
                    nc = cc + dc
                    if nr < 0 or nr >= active_search_bottom or nc < 0 or nc >= cols:
                        continue
                    if visited[nr][nc]:
                        continue
                    if board[nr][nc] != piece:
                        continue
                    visited[nr][nc] = True
                    stack.append((nr, nc))
            count = len(cells)
            if 1 <= count <= 4:
                candidates.append(
                    {
                        "piece": piece,
                        "count": count,
                        "min_r": min(r for r, _ in cells),
                    }
                )
    if not candidates:
        return None
    candidates.sort(
        key=lambda item: (item["count"] == 4, -item["count"], -item["min_r"]),
        reverse=True,
    )
    return candidates[0]["piece"]


def scan_board(frame, config):
    board_cfg = config["board"]
    palette = config["piece_palette"]
    recog = config["recognition"]
    board_rect = Rect.from_dict(board_cfg)
    crop = board_rect.crop(frame)
    rows = int(board_cfg["visible_rows"])
    cols = int(board_cfg["visible_cols"])
    cell_w = board_rect.w / cols
    cell_h = board_rect.h / rows
    board = []
    for r in range(rows):
        row = []
        for c in range(cols):
            x1 = int(round(c * cell_w))
            y1 = int(round(r * cell_h))
            x2 = int(round((c + 1) * cell_w))
            y2 = int(round((r + 1) * cell_h))
            cell = crop[y1:y2, x1:x2]
            if r == 0:
                center = get_inner_crop(
                    cell,
                    recog.get("top_spawn_sample_ratio", max(recog.get("center_sample_ratio", 0.42), 0.52)),
                    y_bias=recog.get("top_spawn_y_bias", 0.38),
                )
            else:
                center = get_inner_crop(cell, recog.get("center_sample_ratio", 0.42))
            avg_rgb = average_rgb(center)
            piece = classify_color(avg_rgb, palette, recog.get("field_threshold", 60), recog)
            if piece in ("empty", "ghost"):
                row.append(".")
            elif piece == "G":
                row.append("X")
            else:
                row.append(piece if piece in PIECES else ".")
        board.append(row)
    board = normalize_mixed_tetromino_components(board)
    board = remove_center_overlay_artifacts(board, config)
    return board


def supported_bool_field_from_board(board_top_first):
    rows = len(board_top_first)
    cols = len(board_top_first[0]) if rows else 0
    bottom_first = [
        [board_top_first[rows - 1 - r][c] in VISIBLE_FIELD_PIECES or board_top_first[rows - 1 - r][c] == "X" for c in range(cols)]
        for r in range(rows)
    ]
    bottom_first = trim_disconnected_components(bottom_first)
    return bottom_first


def trim_disconnected_components(field_bottom_first):
    rows = len(field_bottom_first)
    cols = len(field_bottom_first[0]) if rows else 0
    keep = [[False for _ in range(cols)] for _ in range(rows)]
    queue = deque()
    for col in range(cols):
        if field_bottom_first[0][col]:
            keep[0][col] = True
            queue.append((0, col))
    while queue:
        row, col = queue.popleft()
        for d_row, d_col in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n_row = row + d_row
            n_col = col + d_col
            if 0 <= n_row < rows and 0 <= n_col < cols:
                if field_bottom_first[n_row][n_col] and not keep[n_row][n_col]:
                    keep[n_row][n_col] = True
                    queue.append((n_row, n_col))
    return keep


def default_spawn_zone(board_cfg, spawn_cfg):
    board_rect = Rect.from_dict(board_cfg)
    cell_w = board_rect.w / int(board_cfg["visible_cols"])
    cell_h = board_rect.h / int(board_cfg["visible_rows"])
    x = board_rect.x + int(round(cell_w * float(spawn_cfg["cols_left"])))
    y = board_rect.y - int(round(cell_h * float(spawn_cfg["rows_above"])))
    w = int(round(cell_w * float(spawn_cfg["cols_width"])))
    h = int(round(cell_h * (float(spawn_cfg["rows_above"]) + float(spawn_cfg["rows_inside"]))))
    return {"x": x, "y": y, "w": w, "h": h}


def detect_active_piece(frame, config, board_top_first):
    palette = config["piece_palette"]
    detect_cfg = config.get("active_detection", {})
    prefer_explicit_regions = detect_cfg.get("prefer_explicit_regions", True)
    prefer_shape_for_explicit = detect_cfg.get("prefer_shape_for_explicit_regions", True)

    explicit_candidates = []
    if config.get("active_slot"):
        piece, meta = classify_slot_piece(
            frame,
            config["active_slot"],
            palette,
            config,
            prefer_shape=prefer_shape_for_explicit,
        )
        if piece is not None:
            explicit_candidates.append((piece, meta, "active_slot", config["active_slot"]))

    spawn_cfg = config.get("active_spawn", {})
    if spawn_cfg.get("enabled", True):
        spawn_rect = config.get("spawn_zone") or default_spawn_zone(config["board"], spawn_cfg)
        piece, meta = classify_slot_piece(
            frame,
            spawn_rect,
            palette,
            config,
            prefer_shape=prefer_shape_for_explicit,
        )
        if piece is not None:
            explicit_candidates.append((piece, meta, "spawn_zone", spawn_rect))

    active_piece = guess_active_piece(board_top_first)
    board_candidate = None
    if active_piece is not None:
        board_candidate = (
            active_piece,
            {"reason": "top-board-component"},
            "board_top",
            config["board"],
        )

    if prefer_explicit_regions and explicit_candidates:
        if board_candidate is not None:
            board_piece = board_candidate[0]
            filtered = [candidate for candidate in explicit_candidates if candidate[0] != board_piece]
            if filtered:
                return filtered[0]
        return explicit_candidates[0]

    if board_candidate is not None:
        return board_candidate

    if explicit_candidates:
        return explicit_candidates[0]

    return None, None, None, None


def atomic_write_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


class SpawnTracker:
    def __init__(self, stability_frames):
        self.stability_frames = stability_frames
        self.committed_preview = None
        self.committed_hold = None
        self.candidate_key = None
        self.candidate_count = 0
        self.emit_index = 0

    @staticmethod
    def looks_like_queue_shift(previous_preview, current_preview):
        if len(previous_preview) < 2 or len(current_preview) < 2:
            return False
        overlap = min(len(current_preview), len(previous_preview) - 1)
        if overlap < 2:
            return False
        return current_preview[:overlap] == previous_preview[1 : 1 + overlap]

    @staticmethod
    def is_legal_transition(previous_preview, previous_hold, current_preview, current_hold):
        if previous_preview is None:
            return True
        previous_preview = list(previous_preview)
        current_preview = list(current_preview)
        preview_same = previous_preview == current_preview
        preview_shift = SpawnTracker.looks_like_queue_shift(previous_preview, current_preview)
        hold_changed = previous_hold != current_hold

        if preview_shift:
            return True
        if hold_changed and preview_same:
            return True
        return False

    def update(self, preview_queue, hold_piece, active_piece_now):
        candidate_key = (tuple(preview_queue), hold_piece, active_piece_now)
        if candidate_key == self.candidate_key:
            self.candidate_count += 1
        else:
            self.candidate_key = candidate_key
            self.candidate_count = 1
        if self.candidate_count < self.stability_frames:
            return None
        if self.committed_preview == list(preview_queue) and self.committed_hold == hold_piece:
            return None
        if not self.is_legal_transition(
            self.committed_preview, self.committed_hold, preview_queue, hold_piece
        ):
            return None
        previous_preview = list(self.committed_preview) if self.committed_preview else []
        preview_changed = previous_preview != list(preview_queue)
        if preview_changed and self.looks_like_queue_shift(previous_preview, list(preview_queue)):
            # Once the next queue advances, the strongest signal for the newly spawned active piece
            # is the previous first preview. This is more reliable than re-reading the spawn area
            # while the piece is still partly above the matrix.
            active_piece = previous_preview[0]
        else:
            active_piece = active_piece_now
            if active_piece is None and previous_preview:
                active_piece = previous_preview[0]
        self.committed_preview = list(preview_queue)
        self.committed_hold = hold_piece
        if active_piece is None:
            return None
        self.emit_index += 1
        return active_piece


def leading_detected_pieces(slots):
    pieces = []
    for piece in slots:
        if piece is None:
            break
        pieces.append(piece)
    return pieces


def field_signature(field):
    flat = "".join("1" if cell else "0" for row in field for cell in row)
    return hashlib.sha1(flat.encode("ascii")).hexdigest()[:8]


def build_debug_frame(frame, config, field, hold_piece, active_piece, queue_pieces, active_source, active_rect):
    debug = frame.copy()
    board_rect = Rect.from_dict(config["board"])
    cv2.rectangle(debug, *board_rect.as_xyxy(), (0, 255, 0), 2)
    visible_rows = int(config["board"]["visible_rows"])
    visible_cols = int(config["board"]["visible_cols"])
    cell_w = board_rect.w / visible_cols
    cell_h = board_rect.h / visible_rows
    for row in range(visible_rows):
        for col in range(visible_cols):
            x1 = int(round(board_rect.x + col * cell_w))
            y1 = int(round(board_rect.y + (visible_rows - 1 - row) * cell_h))
            x2 = int(round(x1 + cell_w))
            y2 = int(round(y1 + cell_h))
            color = (0, 255, 0) if field[row][col] else (60, 60, 60)
            cv2.rectangle(debug, (x1, y1), (x2, y2), color, 1)
    if config.get("hold_slot"):
        hold_rect = Rect.from_dict(config["hold_slot"])
        cv2.rectangle(debug, *hold_rect.as_xyxy(), (255, 200, 0), 2)
        cv2.putText(debug, f"hold:{hold_piece}", (hold_rect.x, max(20, hold_rect.y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 200, 0), 2, cv2.LINE_AA)
    if active_rect is None and config.get("active_slot"):
        active_rect = config["active_slot"]
    if active_rect is None and config.get("active_spawn", {}).get("enabled", True):
        active_rect = config.get("spawn_zone") or default_spawn_zone(config["board"], config["active_spawn"])
    if active_rect:
        active_rect = Rect.from_dict(active_rect)
        cv2.rectangle(debug, *active_rect.as_xyxy(), (0, 200, 255), 2)
        cv2.putText(debug, f"active:{active_piece} src:{active_source}", (active_rect.x, max(20, active_rect.y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2, cv2.LINE_AA)
    for index, slot in enumerate(config.get("queue_slots", []), start=1):
        rect = Rect.from_dict(slot)
        cv2.rectangle(debug, *rect.as_xyxy(), (255, 0, 255), 2)
        label = queue_pieces[index - 1] if index - 1 < len(queue_pieces) else None
        cv2.putText(debug, f"q{index}:{label}", (rect.x, max(20, rect.y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 255), 2, cv2.LINE_AA)
    return debug


def save_debug_image(path, frame):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))


def scan_once(frame, config):
    board_top_first = scan_board(frame, config)
    field_bottom_first = supported_bool_field_from_board(board_top_first)
    rows = len(field_bottom_first)
    cols = len(field_bottom_first[0]) if rows else 0
    field = field_bottom_first + [[False for _ in range(cols)] for _ in range(40 - rows)]

    palette = config["piece_palette"]
    queue_results = []
    for slot in config.get("queue_slots", []):
        piece, _meta = classify_slot_piece(frame, slot, palette, config, prefer_shape=True)
        queue_results.append(piece)
    preview_queue = leading_detected_pieces(queue_results)

    hold_piece = None
    if config.get("hold_slot"):
        hold_piece, _meta = classify_slot_piece(frame, config["hold_slot"], palette, config, prefer_shape=True)

    active_piece, active_meta, active_source, active_rect = detect_active_piece(
        frame, config, board_top_first
    )
    return field, hold_piece, active_piece, preview_queue, active_source, active_rect, active_meta


def main():
    parser = argparse.ArgumentParser(description="Capture a Tetris client and emit Cold Clear snapshots.")
    parser.add_argument("config", help="Path to scanner config JSON")
    args = parser.parse_args()

    config = ensure_defaults(load_json(args.config))
    tracker = SpawnTracker(int(config["spawn_stability_frames"]))

    with mss.MSS() as sct:
        region = capture_region_for_monitor(sct, config)
        print(f"[scanner] monitor={config['monitor_index']} region={region['width']}x{region['height']}+{region['left']}+{region['top']}")
        while True:
            frame = grab_frame(sct, region)
            field, hold_piece, active_piece_now, preview_queue, active_source, active_rect, active_meta = scan_once(frame, config)
            if preview_queue:
                active_piece = tracker.update(preview_queue, hold_piece, active_piece_now)
                if active_piece is not None:
                    snapshot = {
                        "token": f"{tracker.emit_index:06d}-{active_piece}-{field_signature(field)}",
                        "field": field,
                        "queue": [active_piece] + preview_queue,
                        "hold": hold_piece,
                        "combo": 0,
                        "b2b": False,
                        "incoming": 0,
                    }
                    atomic_write_json(config["output_path"], snapshot)
                    print(
                        f"[scanner] emitted token={snapshot['token']} active={active_piece} "
                        f"preview={preview_queue} hold={hold_piece} source={active_source} "
                        f"meta={active_meta}"
                    )
                    if config.get("debug_output_path"):
                        debug_frame = build_debug_frame(
                            frame,
                            config,
                            field,
                            hold_piece,
                            active_piece_now,
                            preview_queue,
                            active_source,
                            active_rect,
                        )
                        save_debug_image(config["debug_output_path"], debug_frame)
            elif active_piece_now is not None and active_meta is not None:
                print(f"[scanner] active_detected_without_preview active={active_piece_now} source={active_source} meta={active_meta}")
            time.sleep(max(0.001, config["poll_interval_ms"] / 1000.0))


if __name__ == "__main__":
    main()
