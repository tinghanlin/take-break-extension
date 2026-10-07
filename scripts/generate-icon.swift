import AppKit

let size = 128
let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
context.setFillColor(CGColor(red: 8 / 255, green: 127 / 255, blue: 140 / 255, alpha: 1))
context.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: size, height: size),
                       cornerWidth: 28, cornerHeight: 28, transform: nil))
context.fillPath()
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fillEllipse(in: CGRect(x: 22, y: 22, width: 84, height: 84))
context.setStrokeColor(CGColor(red: 246 / 255, green: 200 / 255, blue: 95 / 255, alpha: 1))
context.setLineWidth(10)
context.setLineCap(.round)
context.addArc(center: CGPoint(x: 64, y: 64), radius: 31,
               startAngle: .pi / 2, endAngle: 0, clockwise: false)
context.strokePath()
context.setStrokeColor(CGColor(red: 23 / 255, green: 32 / 255, blue: 42 / 255, alpha: 1))
context.setLineWidth(9)
context.setLineJoin(.round)
context.move(to: CGPoint(x: 64, y: 85))
context.addLine(to: CGPoint(x: 64, y: 61))
context.addLine(to: CGPoint(x: 82, y: 49))
context.strokePath()
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
let data = bitmap.representation(using: .png, properties: [:])!
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
