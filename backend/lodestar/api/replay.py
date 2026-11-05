"""Sandbox historical replay endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..analysis import jsonable
from ..replay import SPEEDS, controller

router = APIRouter(prefix="/api")


@router.get("/replay")
def replay_state():
    return jsonable(controller.state())


class StartIn(BaseModel):
    start_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    speed: int = 10
    starting_cash: float = Field(100000, ge=100, le=1e9)
    source: str = "auto"


@router.post("/replay/start")
def replay_start(b: StartIn):
    if b.source not in ("auto", "yahoo", "alpaca", "simulation"):
        raise HTTPException(400, "source must be auto, yahoo, alpaca or simulation")
    try:
        return jsonable(controller.start(b.start_date, b.speed, b.starting_cash, b.source))
    except ValueError as e:
        raise HTTPException(400, str(e))


class SpeedIn(BaseModel):
    speed: int


@router.post("/replay/speed")
def replay_speed(b: SpeedIn):
    if b.speed not in SPEEDS:
        raise HTTPException(400, f"speed must be one of {list(SPEEDS)}")
    return jsonable(controller.set_speed(b.speed))


@router.post("/replay/play")
def replay_play():
    try:
        return jsonable(controller.play())
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/replay/pause")
def replay_pause():
    return jsonable(controller.pause())


@router.post("/replay/stop")
def replay_stop():
    try:
        return jsonable(controller.stop())
    except ValueError as e:
        raise HTTPException(400, str(e))
