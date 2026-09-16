"use client";

/*
 * The price chart, on TradingView Lightweight Charts.
 *
 * WHY THIS AND NOT THE WIDGET. The reference runs TradingView's Advanced Charts —
 * the one with the drawing rail, the indicator browser and the symbol search. That
 * product is free to use but it is NOT open source: it loads from TradingView's CDN
 * and it is licensed, not vendored. Lightweight Charts is the open-source library
 * (Apache-2.0), it installs from npm, and it therefore bundles — which is what keeps
 * the `no-external-requests` hard floor passing. A chart that phones home would fail
 * the audit on every capture, and more to the point a spec that depends on someone
 * else's CDN is a spec the team cannot build offline.
 *
 * So: the same rendering engine as the reference's, without the licensed shell
 * around it. The drawing rail and indicator browser are deliberately absent rather
 * than faked — an empty toolbar would be the dead-affordance failure this codebase
 * keeps finding.
 *
 * WHY IT REPLACES OUR HAND-ROLLED SVG. The old CandleChart drew into a fixed 1000×440
 * viewBox and stretched, which is why its labels had to live in an HTML overlay. It
 * had no crosshair, no zoom, no pan, and no time axis worth the name. Those are not
 * decorations on a trading chart; they are the reasons a trader looks at one.
 *
 * The depth and funding views stay ours — see ChartPanel. They are not candlestick
 * data and Lightweight Charts is the wrong tool for either.
 */

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "@/lib/feed";
import { FAINT, GREEN, L1, L2, MONO, MUT, RED } from "@/lib/theme";

/** Their candle bodies are filled and borderless, and so are ours. */
const UP = GREEN;
const DOWN = RED;

export function TvCandleChart({
  candles,
  decimals = 1,
}: {
  candles: Candle[];
  last: number;
  decimals?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  /* First paint fits the series; later paints must not, or every tick would yank the
     viewport back and a trader could never stay zoomed in on anything.
     `span` is the bar interval — when THAT changes the series is a different series
     (a 1h chart is not a zoomed-out 1m chart), so the view has to be refitted or a
     switch from 1h to 1s leaves you looking at a sliver of the new data. */
  const fitted = useRef(false);
  const span = useRef(0);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: MUT,
        fontFamily: MONO,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: L1 },
        horzLines: { color: L1 },
      },
      rightPriceScale: { borderColor: L2, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: L2, timeVisible: true, secondsVisible: false },
      crosshair: {
        // Magnet: the crosshair snaps to OHLC values rather than floating between
        // them, which is what makes reading a level off a candle exact.
        mode: CrosshairMode.Magnet,
        vertLine: { color: L2, labelBackgroundColor: "#1c1c1c" },
        horzLine: { color: L2, labelBackgroundColor: "#1c1c1c" },
      },
      autoSize: true,
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    const p = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
    });
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      // Its own scale, pinned to the bottom quarter — the reference's volume sits
      // under the price rather than sharing its axis.
      priceScaleId: "vol",
      color: FAINT,
    });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.current = c;
    price.current = p;
    volume.current = v;
    return () => {
      c.remove();
      chart.current = null;
      price.current = null;
      volume.current = null;
      fitted.current = false;
    };
  }, [decimals]);

  useEffect(() => {
    if (!price.current || !volume.current || candles.length === 0) return;
    /*
     * Seconds, not milliseconds. Lightweight Charts takes UNIX seconds and silently
     * renders an empty pane for millisecond timestamps — the series is there, the
     * axis is just several thousand years away.
     */
    const bars = candles.map((k) => ({
      time: Math.floor(k.ts / 1000) as UTCTimestamp,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
    }));
    price.current.setData(bars);
    volume.current.setData(
      candles.map((k) => ({
        time: Math.floor(k.ts / 1000) as UTCTimestamp,
        value: k.v,
        color: k.c >= k.o ? "rgba(14,203,129,0.28)" : "rgba(246,70,93,0.28)",
      })),
    );
    const interval = bars.length > 1 ? bars[1].time - bars[0].time : 0;
    if (!fitted.current || interval !== span.current) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
      span.current = interval;
    }
  }, [candles]);

  return (
    <div
      ref={host}
      /*
       * Labelled and focusable. The canvas itself is opaque to a screen reader and to
       * the keyboard, so the container carries the name and the focus stop — the same
       * treatment every scroll region in this app gets.
       */
      tabIndex={0}
      role="img"
      aria-label="Price chart"
      style={{ position: "absolute", inset: 0 }}
    />
  );
}
