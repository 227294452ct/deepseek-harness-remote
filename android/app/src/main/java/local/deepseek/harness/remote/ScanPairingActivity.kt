package local.deepseek.harness.remote

import android.app.Activity
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.InvertedLuminanceSource
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.Result
import com.google.zxing.common.HybridBinarizer
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import java.util.concurrent.Executors

/** Portrait-only pairing scanner with an on-device QR import path. */
class ScanPairingActivity : FragmentActivity() {
    companion object {
        const val EXTRA_QR_CONTENT = "dsh_remote_qr_content"
        private const val MAX_IMAGE_EDGE = 2_048
    }

    private val decodeExecutor = Executors.newSingleThreadExecutor()
    private lateinit var barcodeView: BarcodeView
    private lateinit var galleryAction: LinearLayout
    private var resultSent = false

    private val galleryLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null && !resultSent) decodeGalleryImage(uri)
        else if (!resultSent) restoreGalleryAction()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(11, 14, 18)
        window.navigationBarColor = Color.WHITE
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = true
        }
        setContentView(buildScreen())
        barcodeView.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        barcodeView.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult?) {
                result?.text?.takeIf { it.isNotBlank() }?.let(::finishWithQr)
            }

            override fun possibleResultPoints(resultPoints: MutableList<com.google.zxing.ResultPoint>?) = Unit
        })
    }

    override fun onResume() {
        super.onResume()
        if (!resultSent) barcodeView.resume()
    }

    override fun onPause() {
        barcodeView.pause()
        super.onPause()
    }

    override fun onDestroy() {
        decodeExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun buildScreen(): View {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(11, 14, 18)) }
        barcodeView = BarcodeView(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(barcodeView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(ScanOverlayView(this), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val header = FrameLayout(this)
        val back = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_media_previous)
            setColorFilter(Color.WHITE)
            contentDescription = "返回"
            background = transparentBackground()
            setPadding(dp(8), dp(8), dp(8), dp(8))
            setOnClickListener { finish() }
        }
        val title = TextView(this).apply {
            text = "扫描配对二维码"
            textSize = 22f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        header.addView(back, FrameLayout.LayoutParams(dp(52), dp(52), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = dp(10) })
        header.addView(title, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        root.addView(header, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(72), Gravity.TOP))

        root.addView(buildActionSheet(), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(204), Gravity.BOTTOM))
        return root
    }

    private fun buildActionSheet(): View {
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(9), dp(24), dp(16))
            background = rounded(Color.WHITE, dp(28))
            elevation = dp(12).toFloat()
        }
        val handle = View(this).apply { background = rounded(Color.rgb(220, 226, 235), dp(3)) }
        sheet.addView(handle, LinearLayout.LayoutParams(dp(42), dp(5)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(13) })

        galleryAction = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            isClickable = true
            foreground = selectableItemBackground()
            contentDescription = "从相册识别二维码"
            setOnClickListener { openGallery() }
        }
        val galleryIcon = ImageView(this).apply {
            setImageResource(android.R.drawable.ic_menu_gallery)
            setColorFilter(Color.rgb(40, 125, 255))
            background = rounded(Color.rgb(235, 243, 255), dp(28))
            setPadding(dp(13), dp(13), dp(13), dp(13))
        }
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(17), 0, 0, 0) }
        copy.addView(TextView(this).apply {
            text = "从相册识别二维码"
            textSize = 18f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 34, 51))
        })
        copy.addView(TextView(this).apply {
            text = "支持从本地图片读取配对码"
            textSize = 13f
            setTextColor(Color.rgb(104, 126, 151))
            setPadding(0, dp(3), 0, 0)
        })
        galleryAction.addView(galleryIcon, LinearLayout.LayoutParams(dp(58), dp(58)))
        galleryAction.addView(copy, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        sheet.addView(galleryAction, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(68)))

        val divider = View(this).apply { setBackgroundColor(Color.rgb(234, 238, 244)) }
        sheet.addView(divider, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply { topMargin = dp(8); bottomMargin = dp(3) })
        val paste = TextView(this).apply {
            text = "粘贴配对链接"
            textSize = 16f
            setTextColor(Color.rgb(83, 120, 164))
            gravity = Gravity.CENTER
            isClickable = true
            foreground = selectableItemBackground()
            setOnClickListener { pastePairingLink() }
        }
        sheet.addView(paste, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
        return sheet
    }

    private fun openGallery() {
        galleryAction.isEnabled = false
        galleryAction.alpha = 0.55f
        galleryLauncher.launch("image/*")
    }

    private fun decodeGalleryImage(uri: android.net.Uri) {
        Toast.makeText(this, "正在识别图片中的二维码…", Toast.LENGTH_SHORT).show()
        decodeExecutor.execute {
            val result = runCatching {
                val bitmap = loadScaledBitmap(uri) ?: error("无法读取这张图片")
                decodeQr(bitmap) ?: error("没有识别到二维码")
            }
            runOnUiThread {
                if (result.isSuccess) finishWithQr(result.getOrThrow())
                else {
                    restoreGalleryAction()
                    Toast.makeText(this, result.exceptionOrNull()?.message ?: "图片识别失败，请换一张清晰的二维码图片。", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun loadScaledBitmap(uri: android.net.Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > MAX_IMAGE_EDGE || bounds.outHeight / sample > MAX_IMAGE_EDGE) sample *= 2
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    private fun decodeQr(bitmap: Bitmap): String? {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
        val hints = mapOf<DecodeHintType, Any>(
            DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER to true,
            DecodeHintType.CHARACTER_SET to "UTF-8"
        )
        fun read(luminance: com.google.zxing.LuminanceSource): Result? = runCatching {
            MultiFormatReader().apply { setHints(hints) }
                .decode(BinaryBitmap(HybridBinarizer(luminance)))
        }.getOrNull()
        return (read(source) ?: read(InvertedLuminanceSource(source)))?.text
    }

    private fun pastePairingLink() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val value = if (clipboard.hasPrimaryClip() && clipboard.primaryClipDescription?.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) == true) {
            clipboard.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString()
        } else null
        if (value.isNullOrBlank()) {
            Toast.makeText(this, "剪贴板中没有配对链接。", Toast.LENGTH_SHORT).show()
        } else finishWithQr(value)
    }

    private fun restoreGalleryAction() {
        galleryAction.isEnabled = true
        galleryAction.alpha = 1f
    }

    private fun finishWithQr(value: String) {
        if (resultSent) return
        resultSent = true
        barcodeView.pause()
        setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_QR_CONTENT, value))
        finish()
    }

    private fun rounded(color: Int, radius: Int): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius.toFloat()
    }

    private fun transparentBackground(): GradientDrawable = GradientDrawable().apply { setColor(Color.TRANSPARENT) }
    private fun selectableItemBackground(): android.graphics.drawable.Drawable? = android.util.TypedValue().let { value ->
        theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true)
        ContextCompat.getDrawable(this, value.resourceId)
    }
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}

/** Draws the dimmed camera mask, a square guide, and the gentle blue scan line. */
private class ScanOverlayView(context: Context) : View(context) {
    private val shade = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(158, 0, 0, 0) }
    private val corner = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = dp(4).toFloat()
        strokeCap = Paint.Cap.SQUARE
    }
    private val scanLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(40, 125, 255)
        strokeWidth = dp(2).toFloat()
    }
    private val instruction = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = dp(16).toFloat()
        textAlign = Paint.Align.CENTER
        setShadowLayer(dp(4).toFloat(), 0f, dp(1).toFloat(), Color.BLACK)
    }
    private var frame = RectF()
    private var scanProgress = 0f

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val width = width.toFloat()
        val guideSize = (width - dp(84)).coerceAtLeast(dp(210).toFloat())
        val left = (width - guideSize) / 2f
        val top = (height * 0.255f).coerceAtLeast(dp(135).toFloat())
        frame = RectF(left, top, left + guideSize, top + guideSize)
        canvas.drawRect(0f, 0f, width, frame.top, shade)
        canvas.drawRect(0f, frame.bottom, width, height.toFloat(), shade)
        canvas.drawRect(0f, frame.top, frame.left, frame.bottom, shade)
        canvas.drawRect(frame.right, frame.top, width, frame.bottom, shade)

        val length = dp(28).toFloat()
        drawCorner(canvas, frame.left, frame.top, length, 1f, 1f)
        drawCorner(canvas, frame.right, frame.top, length, -1f, 1f)
        drawCorner(canvas, frame.left, frame.bottom, length, 1f, -1f)
        drawCorner(canvas, frame.right, frame.bottom, length, -1f, -1f)
        scanProgress = (scanProgress + 0.0065f) % 1f
        val y = frame.top + frame.height() * scanProgress
        canvas.drawLine(frame.left + dp(8), y, frame.right - dp(8), y, scanLine)
        canvas.drawText("将电脑端的配对二维码放入框内", width / 2f, frame.bottom + dp(43), instruction)
        postInvalidateOnAnimation()
    }

    private fun drawCorner(canvas: Canvas, x: Float, y: Float, length: Float, horizontal: Float, vertical: Float) {
        canvas.drawLine(x, y, x + length * horizontal, y, corner)
        canvas.drawLine(x, y, x, y + length * vertical, corner)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
