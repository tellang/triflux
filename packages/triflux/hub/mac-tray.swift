import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var webVC: WebViewController!
    var port: String = "27888"

    func applicationDidFinishLaunching(_ aNotification: Notification) {
        if CommandLine.arguments.count > 1 {
            port = CommandLine.arguments[1]
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "T"
            button.target = self
            button.action = #selector(togglePopover(_:))
        }

        webVC = WebViewController()
        webVC.port = port
        webVC.onFocusComplete = { [weak self] in
            self?.popover.performClose(nil)
        }

        popover = NSPopover()
        popover.contentViewController = webVC
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
    }

    @objc func togglePopover(_ sender: Any?) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            if let button = statusItem.button {
                webVC.reloadForPopover()
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            }
        }
    }
}

class WebViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {
    var webView: WKWebView!
    var port: String = "27888"
    let canonicalPort = "27888"
    var consecutiveFailures = 0
    var retryWorkItem: DispatchWorkItem?
    var onFocusComplete: (() -> Void)?

    func logError(_ msg: String) {
        let path = "/tmp/mac-tray.log"
        if let outputStream = OutputStream(toFileAtPath: path, append: true) {
            outputStream.open()
            let text = "\(Date()): \(msg)\n"
            let bytesWritten = outputStream.write(text, maxLength: text.utf8.count)
            outputStream.close()
        }
    }

    override func loadView() {
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.userContentController.add(self, name: "tray")
        let initialFrame = NSRect(x: 0, y: 0, width: 460, height: 720)
        webView = WKWebView(frame: initialFrame, configuration: webConfiguration)

        // Transparent background for Glassmorphism
        webView.setValue(false, forKey: "drawsBackground")

        self.view = NSView(frame: initialFrame)
        webView.frame = self.view.bounds
        webView.autoresizingMask = [.width, .height]
        self.view.addSubview(webView)

        self.preferredContentSize = initialFrame.size
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.navigationDelegate = self
        loadTray()
    }

    func loadTray() {
        retryWorkItem?.cancel()
        if let url = URL(string: "http://127.0.0.1:\(port)/tray.html?t=\(Date().timeIntervalSince1970)") {
            let request = URLRequest(url: url)
            webView.load(request)
        } else {
            logError("Invalid URL")
        }
    }

    func reloadForPopover() {
        if isViewLoaded {
            loadTray()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        logError("Failed to load: \(error.localizedDescription)")
        consecutiveFailures += 1
        if consecutiveFailures >= 3 && port != canonicalPort {
            port = canonicalPort
            consecutiveFailures = 0
            logError("Switching to canonical port \(canonicalPort) after repeated failures")
            loadTray()
            return
        }
        let retry = DispatchWorkItem { [weak self] in
            self?.loadTray()
        }
        retryWorkItem = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: retry)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryWorkItem?.cancel()
        retryWorkItem = nil
        consecutiveFailures = 0
        logError("Successfully loaded URL")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "tray" else { return }
        if let body = message.body as? [String: Any],
           let type = body["type"] as? String,
           type == "focus-complete" {
            DispatchQueue.main.async { [weak self] in
                self?.onFocusComplete?()
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
