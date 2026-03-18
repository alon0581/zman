import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

export function GET(req: NextRequest, { params }: { params: Promise<{ size: string }> }) {
  return params.then(({ size: sizeStr }) => {
    const size = parseInt(sizeStr) || 192
    const r = Math.round(size * 0.22)

    return new ImageResponse(
      (
        <div
          style={{
            width: size,
            height: size,
            background: 'linear-gradient(135deg, #3B7EF7 0%, #6366F1 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: r,
          }}
        >
          <span
            style={{
              color: 'white',
              fontSize: Math.round(size * 0.52),
              fontWeight: 800,
              letterSpacing: '-0.04em',
              lineHeight: 1,
            }}
          >
            Z
          </span>
        </div>
      ),
      { width: size, height: size }
    )
  })
}
