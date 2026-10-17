plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val studioAssets = layout.buildDirectory.dir("generated/assets/studio")
val repoRoot = rootProject.projectDir.parentFile
val buildStudio = tasks.register<Exec>("buildStudio") {
    workingDir(repoRoot)
    // npm comes from PATH (nvm/fnm) unless -PnpmPath=... or NPM=... points at a specific binary.
    commandLine(providers.gradleProperty("npmPath").orElse(providers.environmentVariable("NPM")).getOrElse("npm"), "run", "build")
    // Declared inputs make the Web build incremental; any source change still forces a fresh dist.
    inputs.files(fileTree(repoRoot.resolve("apps/studio")) { exclude("dist/**", "node_modules/**", "*.tsbuildinfo") })
    inputs.dir(repoRoot.resolve("contracts"))
    inputs.files(repoRoot.resolve("services/api/src/meal-draft.mjs"), repoRoot.resolve("package.json"), repoRoot.resolve("package-lock.json"))
    outputs.dir(repoRoot.resolve("apps/studio/dist"))
}
val syncStudioAssets = tasks.register<Sync>("syncStudioAssets") {
    dependsOn(buildStudio)
    from(rootProject.file("../apps/studio/dist")) { into("studio") }
    into(studioAssets)
    doFirst {
        check(rootProject.file("../apps/studio/dist/index.html").isFile) { "Studio build did not produce index.html" }
    }
}

android {
    namespace = "com.withecho.companion"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.withecho.companion"
        minSdk = 26
        targetSdk = 35
        versionCode = 10
        versionName = "0.6.0"
        ndk { abiFilters += "arm64-v8a" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    sourceSets.getByName("debug").java.srcDir("../tests")
    sourceSets.getByName("main").java.srcDir("../../.tools/local-inference-android/sherpa-source")
    sourceSets.getByName("main").jniLibs.srcDir("../../.tools/local-inference-android/jniLibs")
    sourceSets.getByName("main").assets.srcDir("../../contracts/rear-display")
    sourceSets.getByName("main").assets.srcDir("../../contracts/voice-kws")
    sourceSets.getByName("main").assets.srcDir(studioAssets)
    buildTypes {
        debug { applicationIdSuffix = ".dev" }
        release { isMinifyEnabled = false }
    }
}

tasks.named("preBuild") { dependsOn(syncStudioAssets) }
