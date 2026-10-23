// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NabaoCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "NabaoCore", targets: ["NabaoCore"])],
    targets: [
        .target(name: "NabaoCore"),
        .executableTarget(name: "VerifyScreenshots", dependencies: ["NabaoCore"]),
        .executableTarget(name: "VerifyPushClient", dependencies: ["NabaoCore"]),
        .testTarget(name: "NabaoCoreTests", dependencies: ["NabaoCore"])
    ]
)
