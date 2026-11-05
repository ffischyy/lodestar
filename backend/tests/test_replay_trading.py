"""Historical replay (sandbox speed-up), the Trading on/off switch, trade activity sources and
the autopilot's pause / stop-at / swap controls."""
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from lodestar import clock
from lodestar.paper import engine as paper
from lodestar.settings_store import update_settings


# ---------------------------------------------------------------- intraday bridge
@pytest.mark.parametrize("seed", range(20))
def test_bridge_path_hits_real_ohlc(seed):
    from lodestar.replay import bridge_path
    rng = np.random.default_rng(seed)
    o = 100 * np.exp(rng.normal(0, 0.01))
    c = 100 * np.exp(rng.normal(0, 0.02))
    h = max(o, c) * (1 + abs(rng.normal(0, 0.01)))
    l = min(o, c) * (1 - abs(rng.normal(0, 0.01)))
    p = bridge_path(o, h, l, c, seed)
    assert len(p) == 391
    assert p[0] == pytest.approx(o) and p[-1] == pytest.approx(c)
    assert p.max() == pytest.approx(h, rel=1e-9) and p.min() == pytest.approx(l, rel=1e-9)


# ---------------------------------------------------------------- replay lifecycle
@pytest.fixture
def replay(clean_settings, monkeypatch):
    """A replay over the simulated history (the test machine has no internet), model training stubbed."""
    from lodestar.ml import engine as ml
    from lodestar.replay import controller
    monkeypatch.setattr(ml, "start_training_async", lambda: None)
    paper.reset(100_000)
    update_settings({"paper": {"sandbox": True, "trading_enabled": True}})
    controller.start(None, 100, 50_000, source="simulation")
    for _ in range(200):
        if controller.status not in ("loading",):
            break
        time.sleep(0.1)
    assert controller.active, controller.message
    controller.pause()
    yield controller
    if controller.active:
        controller.stop()


def test_replay_requires_sandbox(clean_settings):
    from lodestar.replay import controller
    update_settings({"paper": {"sandbox": False}})
    with pytest.raises(ValueError, match="Sandbox"):
        controller.start(None, 10, 100_000, source="simulation")


def test_replay_rejects_unknown_speed(clean_settings):
    from lodestar.replay import controller
    update_settings({"paper": {"sandbox": True}})
    with pytest.raises(ValueError):
        controller.start(None, 33, 100_000, source="simulation")


def test_replay_switches_data_source_and_clock(replay):
    from lodestar.providers.manager import data
    assert data.provider().name == "replay"
    assert clock.replay_active()
    st = replay.state()
    assert st["simulated_history"] is True and "SIMULATED" in st["source_label"]   # honest label when real data is unavailable
    sim = clock.now()
    assert sim.date().isoformat() == st["current_date"]
    assert sim < datetime.now(timezone.utc) - timedelta(days=5)                    # it really is in the past


def test_replay_never_shows_future_bars(replay):
    from lodestar.providers.manager import data
    replay.minute = 120.0                                                         # 11:30 market time
    df, meta = data.bars("SPY", "1D")
    assert meta["status"] == "replay"
    assert df.index[-1].date().isoformat() == replay.state()["current_date"]
    q = data.quotes(["SPY"], max_age=0)["SPY"]
    assert df["close"].iloc[-1] == pytest.approx(q.price, rel=1e-3)             # today's bar is "so far", not the real close
    di = replay.day_i
    full_close = replay.arrays["SPY"][3][di]
    p = replay.path("SPY", di)
    assert df["high"].iloc[-1] <= p.max() + 1e-9
    assert q.price != pytest.approx(full_close, rel=1e-6) or p[120] == pytest.approx(full_close)
    intr, _ = data.bars("SPY", "5Min", lookback_days=3)
    assert intr.index[-1] <= clock.now()


def test_replay_speed_advances_market_time(replay):
    replay.set_speed(100)
    replay.play()
    d0, m0 = replay.day_i, replay.minute
    replay._advance(0.6)                       # 0.6 s at 100x = 60 market seconds
    assert replay.minute - m0 == pytest.approx(1.0)
    replay.minute = 389.5
    replay._advance(0.6)                       # crosses the close -> next trading day
    assert replay.day_i == d0 + 1 and 0 <= replay.minute < 1
    replay.set_speed(25)
    assert replay.state()["real_seconds_per_day"] == pytest.approx(390 * 60 / 25)
    replay.pause()
    m1 = replay.minute
    replay._advance(1.0)
    assert replay.minute == m1                 # paused: time stands still


def test_replay_account_is_isolated(replay, monkeypatch):
    snap = paper.snapshot()
    assert snap["cash"] == pytest.approx(50_000)                     # replay's own starting cash
    assert "Practice account" in snap["account_label"]
    update_settings({"risk": {"max_position_pct": 100.0, "max_sector_pct": 100.0}})
    replay.minute = 60.0
    o = paper.submit("SPY", "buy", 10)
    assert o["status"] == "filled"
    assert o["filled_at"].startswith(replay.state()["current_date"])   # stamped in replayed time
    paper.deposit(25_000)
    replay.stop()
    main = paper.snapshot()
    assert main["cash"] == pytest.approx(100_000) and not main["positions"]   # normal account untouched
    assert main["account_label"] == "Paper account"
    assert not clock.replay_active()


def test_sandbox_off_ends_replay(replay):
    from fastapi.testclient import TestClient
    from lodestar.main import app
    with TestClient(app) as c:
        r = c.post("/api/paper/sandbox", json={"enabled": False})
        assert r.status_code == 200
    assert not replay.active


# ---------------------------------------------------------------- trading switch & activity
@pytest.fixture
def acct(clean_settings, fixed_quotes):
    paper.reset(100_000)
    update_settings({"paper": {"trading_enabled": True, "sandbox": True},
                     "risk": {"max_position_pct": 100.0, "max_sector_pct": 100.0}})
    fixed_quotes.update({"AAPL": 100.0, "MSFT": 200.0})
    return fixed_quotes


def test_trading_switch_off_blocks_new_orders_but_keeps_protection(acct):
    paper.submit("AAPL", "buy", 10, stop_loss=95.0, take_profit=110.0)
    paper.set_trading(False)
    with pytest.raises(paper.OrderError, match="switched off"):
        paper.submit("MSFT", "buy", 5)
    acct["AAPL"] = 94.0                                  # stop-loss must still fire while trading is off
    from lodestar.providers.manager import data
    fills = paper.process_quotes(data.quotes(["AAPL"]))
    assert fills and fills[0]["source"] == "stop-loss" and "Stop-loss" in fills[0]["reason"]
    assert not paper.snapshot()["positions"]
    paper.set_trading(True)
    assert paper.submit("MSFT", "buy", 5)["status"] == "filled"


def test_trading_off_still_allows_closing(acct):
    paper.submit("AAPL", "buy", 10)
    paper.set_trading(False)
    paper.close_position("AAPL")
    assert not paper.snapshot()["positions"]


def test_trading_off_holds_working_entry_orders(acct):
    paper.submit("AAPL", "buy", 10, order_type="limit", limit_price=99.0)
    paper.set_trading(False)
    acct["AAPL"] = 98.0
    from lodestar.providers.manager import data
    assert paper.process_quotes(data.quotes(["AAPL"])) == []           # does not fill while off
    paper.set_trading(True)
    assert len(paper.process_quotes(data.quotes(["AAPL"]))) == 1


def test_activity_shows_who_traded_and_why(acct):
    paper.submit("AAPL", "buy", 10, note="my idea")
    paper.submit("MSFT", "buy", 5, client_order_id="auto-test123", note="autopilot entry")
    act = paper.activity()
    by_sym = {f["symbol"]: f for f in act["fills"]}
    assert by_sym["AAPL"]["source"] == "you" and by_sym["AAPL"]["reason"] == "my idea"
    assert by_sym["MSFT"]["source"] == "ai"
    assert by_sym["AAPL"]["total"] == pytest.approx(1000) and act["account"] == "Paper account"


def test_trading_api_switch(acct):
    from fastapi.testclient import TestClient
    from lodestar.main import app
    with TestClient(app) as c:
        assert c.post("/api/paper/trading", json={"enabled": False}).json()["trading_enabled"] is False
        assert c.get("/api/status").json()["paper_trading_enabled"] is False
        assert c.post("/api/paper/trading", json={"enabled": True}).json()["trading_enabled"] is True
        assert "fills" in c.get("/api/paper/activity").json()


# ---------------------------------------------------------------- autopilot timing controls
def test_autopilot_pause_and_stop_at(acct):
    from lodestar import autopilot
    autopilot.set_enabled(True)
    autopilot.pause(minutes=30)
    res = autopilot.run_cycle()
    assert "Paused by you" in res["summary"]
    autopilot.pause()                                    # clear
    assert autopilot.status()["pause_until"] is None
    autopilot.set_stop_at((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat())
    res = autopilot.run_cycle()
    assert "Stopped" in res["summary"]
    from lodestar.settings_store import get_settings
    assert get_settings()["autopilot"]["enabled"] is False


def test_autopilot_waits_while_trading_off(acct):
    from lodestar import autopilot
    autopilot.set_enabled(True)
    paper.set_trading(False)
    assert "switched off" in autopilot.run_cycle()["summary"]
    paper.set_trading(True)


def test_ai_exit_is_attributed_to_ai(acct):
    paper.submit("AAPL", "buy", 10, client_order_id="auto-entry1", note="autopilot entry")
    paper.close_position("AAPL", client_order_id="auto-exit1", note="autopilot exit")
    fills = paper.activity()["fills"]
    assert all(f["source"] == "ai" for f in fills)


def test_practice_mode_is_sandbox_only(clean_settings):
    from lodestar import scanner
    update_settings({"autopilot": {"practice_mode": True}, "paper": {"sandbox": False}})
    assert scanner.practice_mode() is False
    update_settings({"paper": {"sandbox": True}})
    assert scanner.practice_mode() is True


def test_theme_saves_name_colours_and_look(clean_settings):
    from fastapi.testclient import TestClient
    from lodestar.main import app
    tokens = {"accent": "#ff8800", "bg": "#101418", "pref-fontScale": "1.1", "pref-density": "compact",
              "pref-font": "'Space Grotesk', 'IBM Plex Sans', system-ui, sans-serif", "pref-shadows": "0"}
    with TestClient(app) as c:
        r = c.post("/api/themes", json={"name": "Night shift", "base": "meridian", "tokens": tokens})
        assert r.status_code == 200, r.text
        tid = r.json()["id"]
        got = {t["id"]: t for t in c.get("/api/themes").json()}[tid]
        assert got["name"] == "Night shift" and got["tokens"]["pref-density"] == "compact"
        r = c.put(f"/api/themes/{tid}", json={"name": "Night shift v2", "base": "meridian", "tokens": tokens})
        assert r.json()["name"] == "Night shift v2"
        assert c.post("/api/themes", json={"name": "bad", "tokens": {"accent": "red;}</style>"}}).status_code == 400
        c.delete(f"/api/themes/{tid}")


def test_pickiness_levels():
    from lodestar.autopilot import effective_min_score, eligible
    strict_ok = {"rejected": False, "reasons": [], "net_exp_return": 0.01, "prob_edge": 0.05}
    soft = {"rejected": True, "reasons": ["Probability edge +1.0% below 3% (x)"], "net_exp_return": 0.004, "prob_edge": 0.01}
    tiny = {"rejected": True, "reasons": ["Expected return after costs +0.05% below 0.25%."], "net_exp_return": 0.0005, "prob_edge": 0.002}
    negative = {"rejected": True, "reasons": ["Expected return after costs -0.20% below 0.25%."], "net_exp_return": -0.002, "prob_edge": 0.02}
    hard = {"rejected": True, "reasons": ["Spread 40.0 bps above 25 bps."], "net_exp_return": 0.02, "prob_edge": 0.1}
    assert eligible(strict_ok, "strict") and not eligible(soft, "strict")
    assert eligible(soft, "balanced") and not eligible(tiny, "balanced")
    assert eligible(tiny, "active")
    for lvl in ("strict", "balanced", "active"):
        assert not eligible(negative, lvl)            # never trades a negative expected result
        assert not eligible(hard, lvl)                # safety rules always apply
    assert effective_min_score({"min_score": 60, "pickiness": "balanced"}) == 45
    assert effective_min_score({"min_score": 60, "pickiness": "strict"}) == 60


def test_turbo_money_adds_up():
    from lodestar import turbo
    r = turbo.run(turbo.TurboConfig(markets=2, symbols=60, years=3, starting_cash=25_000, seed=3, strategy="momentum"))
    m = r["money"]
    assert m["start_cash"] == 25_000
    last = r["markets"][-1]
    assert last["final_value"] == pytest.approx(25_000 * (1 + last["total_return_pct"] / 100), rel=1e-6)
    if m["latest_tape"]:
        assert m["latest_tape"][-1]["balance"] == pytest.approx(last["final_value"], abs=1.0)
