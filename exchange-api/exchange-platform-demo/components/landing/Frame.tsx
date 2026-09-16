/*
 * The frame around a product capture.
 *
 * WHY A FRAME AT ALL. These are dark screenshots on a dark page. Without an edge
 * they dissolve into the background and the reader cannot tell where the product
 * stops and the marketing starts — which, on a page whose argument is "here is the
 * actual thing", is the one boundary that has to be legible.
 *
 * WHY NOT A MOCKUP. The stock answer is a browser chrome with a rounded bar and
 * three coloured dots, or a floating laptop. Both say "this is a picture of a
 * website". The thing in these captures is a trading terminal and a venue console,
 * and their own chrome is a hairline and a label strip — so the frame is the same
 * panel treatment every other surface on this page uses, with a caption rail that
 * names what you are looking at and captions it.
 *
 * The captures are 2880x1800 on purpose; `next/image` derives the sizes actually
 * served, and `sizes` is what tells it which. Everything here is lazy except a
 * frame explicitly marked `priority`.
 */

import Image from "next/image";
import type { ReactNode } from "react";

import { FAINT, L1, MONO } from "@/lib/theme";

import { css as s, eyebrow } from "./primitives";

export type ShotSpec = {
  src: string;
  /** Describes what is on screen. Never "screenshot" — a reader who cannot see it
   *  needs the content, and the fact that it is an image is already announced. */
  alt: string;
};

/**
 * One capture, sized and lazy.
 *
 * `sizes` assumes the widest a frame ever gets is the 1180px content column, and
 * that below 1100px it is the full viewport minus gutters. Both are true of every
 * call site on this page; a new one that is narrower should pass its own.
 */
export function Shot({
  spec,
  priority = false,
  sizes = "(min-width: 1220px) 1140px, 96vw",
}: {
  spec: ShotSpec;
  priority?: boolean;
  sizes?: string;
}) {
  return (
    <Image
      className={s.shotImg}
      src={spec.src}
      alt={spec.alt}
      width={1440}
      height={900}
      sizes={sizes}
      priority={priority}
      loading={priority ? undefined : "lazy"}
    />
  );
}

export function Frame({
  label,
  meta,
  children,
  shotClass,
  style,
}: {
  label: string;
  /** A short right-aligned annotation: the palette, the environment, the caveat. */
  meta?: ReactNode;
  children: ReactNode;
  /** Extra class on the shot box — the comparison needs a wider one under reduced motion. */
  shotClass?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={s.frame} style={style}>
      <div className={s.frameRail}>
        <span style={eyebrow()}>{label}</span>
        {meta && (
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: FAINT }}>
            {meta}
          </span>
        )}
      </div>
      <div className={shotClass ? `${s.shot} ${shotClass}` : s.shot}>{children}</div>
    </div>
  );
}

/**
 * A magnified region of a capture, beside the whole of it.
 *
 * A full frame shows scale; a crop shows craft. The region is an offset in the
 * capture's own 1440x900 coordinate space and lives at the call site, because WHICH
 * pixels are worth enlarging is content — a crop that drifts because someone
 * recaptured the screen is a caption that has quietly started lying. How much it is
 * enlarged is layout and lives in the stylesheet, where it can change at a breakpoint.
 */
export function Crop({
  spec,
  height,
  x,
  y,
  caption,
}: {
  spec: ShotSpec;
  /** Box height in px. Width is fluid. */
  height: number;
  /** Top-left of the region, in the capture's own 1440x900 units. */
  x: number;
  y: number;
  caption: string;
}) {
  return (
    <figure style={{ margin: 0 }}>
      <div className={s.crop} style={{ height }}>
        {/*
         * The magnification is a CSS transform on an image laid out at the capture's
         * own 1440x900, NOT an <Image> asked for a 2160px-wide derivative. Same
         * result on screen, and it means the crop reuses the derivative the full
         * frame already downloaded rather than making the optimiser resize a
         * 2880x1800 source a second time at a size nothing else on the page needs.
         *
         * The scale factor is in the stylesheet because it changes at a breakpoint —
         * see `.cropInner`. Only the region travels from here.
         */}
        <div className={s.cropInner} style={{ ["--cx" as string]: `${-x}px`, ["--cy" as string]: `${-y}px` }}>
          <Image
            src={spec.src}
            alt={spec.alt}
            width={1440}
            height={900}
            sizes="1440px"
            loading="lazy"
            style={{ display: "block", width: 1440, height: 900 }}
          />
        </div>
      </div>
      <figcaption
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: `1px solid ${L1}`,
          fontFamily: MONO,
          fontSize: 10.5,
          lineHeight: 1.5,
          color: FAINT,
        }}
      >
        {caption}
      </figcaption>
    </figure>
  );
}
