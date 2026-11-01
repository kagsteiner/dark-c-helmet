// Run from webapp: swift -module-cache-path /tmp/darkhelmet-swift-cache tools/generate-icons.swift
// Vector reconstruction of the approved Dark Helmet concept; no external dependencies.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("public/icons")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let ink = "#171816"
let ivory = "#F8F5EB"
// Coordinates use a 512 × 512 canvas, with the origin at the top left.
let shapes: [(String, String)] = [
    (ink, "M 58 345 C 78 318 88 284 99 225 C 113 146 122 115 153 97 C 194 73 291 73 335 95 C 371 112 384 147 398 220 C 411 286 427 318 454 345 C 465 361 411 376 363 378 C 325 380 300 366 256 366 C 211 366 190 380 151 378 C 103 376 48 362 58 345 Z"),
    (ivory, "M 61 347 C 101 322 111 267 133 233 C 151 205 184 199 255 199 C 325 199 360 205 379 233 C 400 266 411 322 451 347 L 447 352 C 404 329 389 277 375 244 C 355 231 310 223 256 223 C 201 223 157 231 138 244 C 122 279 107 329 65 352 Z"),
    (ivory, "M 137 239 C 177 245 205 257 229 269 L 229 345 L 273 345 L 273 269 C 298 257 337 245 375 239 L 368 245 C 334 255 310 268 292 279 L 292 348 L 211 348 L 211 279 C 191 266 167 255 143 248 Z"),
    (ivory, "M 91 329 C 136 340 188 348 255 348 C 322 348 376 340 419 329 L 422 334 C 374 347 320 354 255 354 C 189 354 137 347 88 334 Z"),
    (ink, "M 210 355 C 215 374 231 384 227 397 C 224 407 217 414 208 420 L 304 420 C 294 412 286 404 284 396 C 281 383 298 374 302 355 C 276 361 238 361 210 355 Z"),
    (ink, "M 204 425 L 308 425 C 317 425 322 432 322 438 C 322 445 317 449 308 449 L 204 449 C 195 449 190 445 190 438 C 190 431 195 425 204 425 Z"),
    (ink, "M 210 455 L 302 455 C 320 455 332 468 332 482 L 180 482 C 180 468 192 455 210 455 Z")
]

func path(_ data: String) -> CGPath {
    let tokens = data.split(separator: " ").map(String.init)
    let result = CGMutablePath()
    var i = 0
    func number() -> CGFloat { defer { i += 1 }; return CGFloat(Double(tokens[i])!) }
    while i < tokens.count {
        let command = tokens[i]; i += 1
        switch command {
        case "M": let x = number(); let y = number(); result.move(to: CGPoint(x: x, y: y))
        case "L": let x = number(); let y = number(); result.addLine(to: CGPoint(x: x, y: y))
        case "C":
            let x1 = number(), y1 = number(), x2 = number(), y2 = number(), x = number(), y = number()
            result.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
        case "Z": result.closeSubpath()
        default: fatalError("Unknown SVG command: \(command)")
        }
    }
    return result
}
func color(_ hex: String) -> CGColor {
    let n = UInt32(hex.dropFirst(), radix: 16)!
    return CGColor(red: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1)
}
// Center the tall concept on the canvas. Maskable versions keep the complete mark
// inside Android's central safe circle (radius 40% of the canvas).
func transform(_ maskable: Bool) -> String { maskable ? "translate(256 256) scale(0.72) translate(-256 -281)" : "translate(256 256) scale(0.96) translate(-256 -281)" }
func svg(maskable: Bool = false) -> String {
    let paths = shapes.map { "    <path fill=\"\($0.0)\" d=\"\($0.1)\"/>" }.joined(separator: "\n")
    return """
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <title>Dark C. Helmet</title>
      <rect width="512" height="512" fill="\(ivory)"/>
      <g transform="\(transform(maskable))">
    \(paths)
      </g>
    </svg>

    """
}
func render(size: Int, maskable: Bool = false) throws -> Data {
    // Render at 4× output size for smoother small favicons.
    let pixels = max(size, min(size * 4, 2048))
    let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(color(ivory)); context.fill(CGRect(x: 0, y: 0, width: pixels, height: pixels))
    context.translateBy(x: 0, y: CGFloat(pixels)); context.scaleBy(x: CGFloat(pixels) / 512, y: -CGFloat(pixels) / 512)
    context.translateBy(x: 256, y: 256)
    let scale: CGFloat = maskable ? 0.72 : 0.96
    context.scaleBy(x: scale, y: scale); context.translateBy(x: -256, y: -281)
    for (fill, data) in shapes { context.setFillColor(color(fill)); context.addPath(path(data)); context.fillPath() }
    let image = context.makeImage()!
    let resized = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    resized.interpolationQuality = .high
    resized.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    let data = NSMutableData()
    let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, resized.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("PNG export failed") }
    return data as Data
}
try svg().write(to: output.appendingPathComponent("darkhelmet.svg"), atomically: true, encoding: .utf8)
for size in [16, 32, 48, 180, 192, 512, 1024] {
    let name = size == 180 ? "apple-touch-icon.png" : "icon-\(size).png"
    try render(size: size).write(to: output.appendingPathComponent(name))
}
for size in [192, 512] {
    try render(size: size, maskable: true).write(to: output.appendingPathComponent("icon-maskable-\(size).png"))
}
// ICO directory with embedded PNGs at the three conventional browser sizes.
func le16(_ n: Int) -> Data { Data([UInt8(n & 255), UInt8((n >> 8) & 255)]) }
func le32(_ n: Int) -> Data { Data((0..<4).map { UInt8((n >> ($0 * 8)) & 255) }) }
let sizes = [16, 32, 48]
let pngs = try sizes.map { try render(size: $0) }
var ico = le16(0) + le16(1) + le16(sizes.count)
var offset = 6 + sizes.count * 16
for (size, png) in zip(sizes, pngs) {
    ico.append(contentsOf: [UInt8(size), UInt8(size), 0, 0])
    ico.append(le16(1)); ico.append(le16(32)); ico.append(le32(png.count)); ico.append(le32(offset)); offset += png.count
}
for png in pngs { ico.append(png) }
try ico.write(to: output.deletingLastPathComponent().appendingPathComponent("favicon.ico"))
print("Generated SVG, favicon.ico, and nine PNG icons in public/icons.")
