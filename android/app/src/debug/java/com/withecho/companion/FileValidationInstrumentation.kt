package com.withecho.companion

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.UUID

/** Debug-only fixed synthetic fixture; never initializes AudioRecord or reads user media. */
class FileValidationInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val fixture = File(targetContext.cacheDir, "wave-fixture-${UUID.randomUUID()}")
        val result = Bundle()
        try {
            check(fixture.mkdir())
            result.putString("result", WaveChunkWriterTest.run(fixture.toPath()))
            val directory = Os.open(File(fixture,"complete").absolutePath,OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW,0)
            try { check(OsConstants.S_ISDIR(Os.fstat(directory).st_mode));Os.fsync(directory) } finally { Os.close(directory) }
            result.putBoolean("directory_fsync",true)
            result.putBoolean("microphone_started", false)
            result.putBoolean("private_audio_read", false)
            finish(Activity.RESULT_OK, result)
        } catch (failure: Throwable) {
            result.putString("error", failure.javaClass.simpleName + ": " + failure.message)
            finish(Activity.RESULT_CANCELED, result)
        } finally {
            fixture.deleteRecursively() // only this UUID fixture created above
        }
    }
}
