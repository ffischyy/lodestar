export type DataStatus = "live" | "delayed" | "cached" | "historical" | "simulated" | "replay" | "stale" | "unavailable";

export interface Quote {
  symbol: string; price: number; ts: string; status: DataStatus; source: string;
  prev_close: number | null; open: number | null; high: number | null; low: number | null; volume: number | null;
  bid: number | null; ask: number | null; session: string; venue_note: string;
  change: number | null; change_pct: number | null; spread_bps: number | null;
}

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface LinePoint { time: number; value: number }
export interface BarsResponse {
  symbol: string; timeframe: string; candles: Candle[];
  meta: { status: DataStatus; source: string; issues: string[]; last_bar: string | null; bars: number };
  indicators: Record<string, LinePoint[] | Record<string, LinePoint[]>>;
}

export interface Signal {
  key: string; name: string; category: string; score: number; direction: string; summary: string;
  values: Record<string, number | string | boolean | null>; flags: string[];
}

export interface Forecast {
  symbol: string; asof: string; price_asof: number; horizon_days: number; model: string; model_run_id: number; validated: boolean;
  reliability: number; source: string; p_up: number; p_target_first_long: number; p_target_first_short: number;
  exp_return: number; q10: number; q90: number; uncertainty: number; exp_volatility: number;
  exp_favorable_excursion: number; exp_adverse_excursion: number; potential_downside: number;
  barrier_target_atr: number; barrier_stop_atr: number; atr_pct: number;
  by_method?: Record<string, { p_up: number; p_target_first_long: number; p_target_first_short: number }>;
}

export interface ModelInfo {
  run_id: number; champion: string; passed: boolean; reliability: number; source: string; trained_through: string;
  horizon_days: number; barrier_target_atr: number; barrier_stop_atr: number;
}

export interface Evidence { source: string; category: string; text: string; score: number }

export interface Plan {
  direction: "long" | "short"; entry: number; entry_low: number; entry_high: number; stop: number; targets: number[];
  atr: number; risk_per_share: number; reward_risk: number; invalidation: string;
}

export interface Candidate {
  symbol: string; name: string; sector: string; direction: "long" | "short"; strategy: string; price: number; data_status: DataStatus;
  horizon_days: number; exp_return: number; net_exp_return: number; q10: number; q90: number; uncertainty: number;
  p_profit: number; p_target_first: number; base_target_first: number; prob_edge: number; reward_risk: number;
  model_reward_risk: number; model_reliability: number; signal_agreement: number; avg_dollar_volume: number;
  spread_bps: number | null; regime: string; plan: Plan;
  sizing: { qty: number; risk_budget: number; per_share_risk: number; position_value: number; risk_at_stop: number; risk_pct_of_equity: number; binding_constraint: string; notes: string[] };
  costs: { round_trip_pct: number; round_trip_cost: number; spread_bps: number; slippage_bps: number; spread_source: string };
  score: number; components: Record<string, number>; supporting: Evidence[]; contradicting: Evidence[]; risks: string[];
  notes: string[]; rejected: boolean; reasons: string[]; forecast_asof: string; signals: Record<string, number>; next_earnings: string | null;
}

export interface ScanResult {
  scanned_at: string; duration_s: number; universe_size: number; candidates: Candidate[]; rejected: Candidate[];
  errors: { symbol: string; error: string }[]; regime: Signal; model: ModelInfo | null; provider: string; simulated: boolean;
  settings: Record<string, unknown>; reason_counts: { reason: string; count: number }[];
}

export interface NewsItem {
  id: number; ts: string; headline: string; summary: string; url: string; publisher: string; symbols: string[];
  sentiment: number; terms: string[]; simulated: boolean;
}

export interface Profile {
  symbol: string; name: string; sector: string; industry: string; market_cap: number | null; pe_ratio: number | null;
  forward_pe: number | null; eps: number | null; dividend_yield: number | null; beta: number | null;
  fifty_two_week_high: number | null; fifty_two_week_low: number | null; next_earnings: string | null; description: string;
  source: string; simulated: boolean; fields_unavailable: string[];
}

export interface PredictionRow {
  id: number; symbol: string; asof: string; created_at: string; horizon_days: number; model: string; model_run_id: number;
  price: number; p_up: number; p_target_first: number; exp_return: number; q10: number; q90: number; target_price: number;
  stop_price: number; resolved: boolean; realized_return: number | null; hit: string | null; source: string;
}

export interface Research {
  symbol: string; name: string; sector: string; quote: Quote | null; profile: Profile | null; signals: Signal[]; regime: Signal;
  forecast: Forecast | null; model: ModelInfo | null; lean: "long" | "short";
  plans: Record<"long" | "short", { plan: Plan; agreement: number; evidence: { supporting: Evidence[]; contradicting: Evidence[] }; risks: string[] }>;
  history: { window_days: number; long_target_first_rate: number; short_target_first_rate: number; positive_return_rate: number; median_fwd_return: number };
  news: NewsItem[]; prediction_history: PredictionRow[]; narrative: string; llm_available: boolean; generated_at: string;
  bars_meta: { status: DataStatus; issues: string[]; source: string };
}

export interface Position {
  symbol: string; qty: number; side: "long" | "short"; avg_price: number; mark: number; market_value: number; unrealized: number;
  unrealized_pct: number; sector: string; data_status: DataStatus; opened_at: string; day_change_pct: number | null;
}
export interface Order {
  id: number; created_at: string; client_order_id: string; symbol: string; side: "buy" | "sell"; qty: number; type: string;
  limit_price: number | null; stop_price: number | null; status: string; filled_price: number | null; filled_at: string | null;
  parent_id: number | null; oco_group: string | null; bracket_stop: number | null; bracket_target: number | null; commission: number; note: string; data_status: string;
}
export type TradeSource = "you" | "ai" | "stop-loss" | "take-profit";
export interface Fill {
  id: number; order_id: number; ts: string; symbol: string; side: string; qty: number; price: number; commission: number; realized_pnl: number;
  total?: number; type?: string; source?: TradeSource; reason?: string; closing?: boolean; account?: string;
}
export interface WorkingOrder extends Order { source: TradeSource; owner: TradeSource; trigger: number | null }
export interface Activity { account: string; fills: Fill[]; working: WorkingOrder[]; trading_enabled: boolean }
export interface ReplayBrief {
  active: boolean; status: string; speed: number; playing: boolean; sim_time_et: string | null; current_date: string | null; progress: number;
  message: string; simulated_history: boolean; source_label: string; day_progress: number;
}
export interface ReplayState extends ReplayBrief {
  speeds: number[]; source: string; start_cash: number; start_date: string | null; last_date: string | null; sim_time: string | null;
  days_replayed: number; days_left: number; real_seconds_per_day: number; earliest_start: string; latest_start: string; default_start: string;
  summary: null | { equity?: number; profit?: number; return_pct?: number; trades?: number; win_rate_pct?: number | null; spy_return_pct?: number | null;
    days_replayed?: number; from?: string; to?: string; error?: string };
}
export interface Money {
  starting_cash: number; deposits: number; withdrawals: number; net_deposits: number; cash: number; reserved_for_orders: number;
  available_to_trade: number; invested_cost: number; long_market_value: number; short_market_value: number; equity: number;
  profit: number; return_pct: number; total_bought: number; total_sold: number; fees_paid: number; trades: number; closed_trades: number;
  win_rate_pct: number | null; cash_pct: number; invested_pct: number; open_positions: number;
}
export interface Account {
  money: Money; sandbox: boolean;
  starting_cash: number; cash: number; equity: number; buying_power: number; market_value: number; realized_pnl: number;
  unrealized_pnl: number; total_pnl: number; total_return_pct: number; day_pnl: number; day_pnl_pct: number; drawdown_pct: number;
  peak_equity: number; halted_reason: string | null; trading_enabled: boolean; positions: Position[]; orders: (Order & { source?: TradeSource })[]; fills: Fill[];
  account_label?: string;
}

export interface Status {
  version: string; provider: string; provider_label: string; simulated: boolean; quote_status: DataStatus;
  clock: { now_et: string; session: string; trading_day: boolean };
  model: ModelInfo | null; training: boolean; training_run: { id: number; progress: number; message: string } | null;
  scanner_running: boolean; unread_alerts: number; paper_trading_enabled: boolean; live_trading_enabled: boolean;
  sandbox: boolean; autopilot_enabled: boolean; autopilot_mode: "auto" | "approve"; autopilot_paused_until: string | null;
  replay: ReplayBrief;
}

export interface AlertEvent { id: number; alert_id: number | null; ts: string; level: string; title: string; body: string; symbol: string | null; read: boolean }

export interface Widget { i: string; widget: string; x: number; y: number; w: number; h: number; config?: Record<string, unknown> }
export interface DashboardT { id: number; name: string; layout: Widget[]; is_default: boolean; updated_at: string }

export interface AutopilotEventT {
  id: number; ts: string; kind: "buy" | "sell" | "skip" | "proposal" | "info" | "error"; symbol: string | null; qty: number | null;
  price: number | null; reason: string; order_id: number | null; status: string; payload: Record<string, unknown>;
}
export interface AutopilotSettings {
  enabled: boolean; mode: "auto" | "approve"; schedule: "auto" | "market_hours" | "always" | "custom"; custom_start: string; custom_end: string;
  days: number[]; interval_seconds: number; min_score: number; max_trades_per_day: number; max_open_positions: number;
  max_position_pct: number; max_capital_pct: number; allow_short: boolean; use_brackets: boolean; exit_on_signal_flip: boolean;
  max_hold_days: number; symbols_mode: "universe" | "watchlist"; watchlist_id: number | null; stop_on_daily_loss_pct: number;
  proposal_ttl_minutes: number; rotate_for_better: boolean; rotate_margin: number; pause_until: string | null; stop_at: string | null; practice_mode: boolean; pickiness: "strict" | "balanced" | "active";
}
export interface AutopilotStatus {
  enabled: boolean; mode: string; schedule_ok: boolean; schedule_note: string; paused_reason: string | null; last_cycle: string | null;
  last_summary: string; trades_today: number; max_trades_per_day: number; open_positions: number; max_open_positions: number;
  invested: number; unrealized: number; realized: number; pending: number; positions: (Position & { entered_at: string })[];
  model: ModelInfo | null; paper_trading_enabled: boolean; universe: number; settings: AutopilotSettings;
  pause_until: string | null; stop_at: string | null; now: string; next_cycle: string | null; practice_mode: boolean; sandbox: boolean;
  pickiness: string; pickiness_options: Record<string, { label: string; about: string; min_score: number | null }>; effective_min_score: number;
}
export interface MethodInfo { name: string; family: string; about: string }
