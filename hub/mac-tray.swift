import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var port: String = "27888"

    func applicationDidFinishLaunching(_ aNotification: Notification) {
        if CommandLine.arguments.count > 1 {
            port = CommandLine.arguments[1]
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "T"
            button.action = #selector(togglePopover(_:))
        }

        let webVC = WebViewController()
        webVC.port = port
        
        popover = NSPopover()
        popover.contentViewController = webVC
        popover.behavior = .transient
        popover.delegate = self
    }

    @objc func togglePopover(_ sender: Any?) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            if let button = statusItem.button {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }
}

class WebViewController: NSViewController {
    var webView: WKWebView!
    var port: String = "27888"

    override func loadView() {
        let webConfiguration = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: webConfiguration)
        
        // Transparent background for Glassmorphism
        webView.setValue(false, forKey: "drawsBackground")
        
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        webView.frame = self.view.bounds
        webView.autoresizingMask = [.width, .height]
        self.view.addSubview(webView)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let url = URL(string: "http://127.0.0.1:\(port)/tray.html") {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
