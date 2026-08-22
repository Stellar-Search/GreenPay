import React, { useRef, useCallback } from "react";
import { QRCodeCanvas } from "qrcode.react";

interface DonationQRCodeProps {
  stellarUri: string;
  projectName: string;
  size?: number;
}

/**
 * Renders a QR code for a SEP-0007 stellar:pay URI and exposes
 * a download-as-PNG helper via an imperative ref.
 *
 * Usage:
 *   const ref = useRef<DonationQRCodeHandle>(null);
 *   <DonationQRCode ref={ref} stellarUri="web+stellar:pay?..." projectName="..." />
 *   ref.current?.downloadPNG();
 */
export interface DonationQRCodeHandle {
  downloadPNG: () => void;
}

const DonationQRCode = React.forwardRef<DonationQRCodeHandle, DonationQRCodeProps>(
  ({ stellarUri, projectName, size = 280 }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Expose downloadPNG to parent via ref
    React.useImperativeHandle(ref, () => ({
      downloadPNG() {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const link = document.createElement("a");
        link.download = `greenpay-qr-${projectName
          .toLowerCase()
          .replace(/\s+/g, "-")}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
      },
    }));

    // qrcode.react renders a <canvas>; we capture its ref via the id trick
    const onCanvasRef = useCallback((node: HTMLElement | null) => {
      if (node) {
        const canvas = node.querySelector("canvas");
        if (canvas) canvasRef.current = canvas;
      }
    }, []);

    return (
      <div
        ref={onCanvasRef}
        className="donation-qr-wrapper"
        style={{ display: "inline-block" }}
      >
        <QRCodeCanvas
          value={stellarUri}
          size={size}
          level="H"          // High error correction – scannable even if partially obscured when printed
          includeMargin={true}
          imageSettings={{
            src: "/logo-mark.png",   // small centre logo; harmless 404 if absent
            height: Math.round(size * 0.18),
            width: Math.round(size * 0.18),
            excavate: true,
          }}
          role="img"
          aria-label={`QR code to donate to ${projectName}`}
          title={`QR code to donate to ${projectName}`}
          style={{ display: "block" }}
        />
      </div>
    );
  }
);

DonationQRCode.displayName = "DonationQRCode";
export default DonationQRCode;