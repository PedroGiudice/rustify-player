plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tauri.rustifyaudio"
    compileSdk = 36

    defaultConfig {
        minSdk = 24

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

// Media3 1.10.1 e a ultima estavel compativel com o Kotlin Gradle Plugin 1.9.25
// que o `tauri android init` gera. A 1.11.0 arrasta kotlin-stdlib 2.2.10, cuja
// metadata e mv=[2,2,0] e o compilador 1.9 recusa ("incompatible version of
// Kotlin"). A 1.10.1 arrasta stdlib 2.0.20, que ainda publica mv=[1,9,0].
// Se o projeto Android subir pro KGP 2.x, da pra ir pra 1.11.0.
val media3Version = "1.10.1"

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    implementation("androidx.media3:media3-exoplayer:$media3Version")
    implementation("androidx.media3:media3-session:$media3Version")
    testImplementation("junit:junit:4.13.2")
    // O android.jar dos testes JVM e um stub ("Method ... not mocked"); o
    // org.json real na frente do classpath deixa UpdateManifest.parse rodar
    // fora do aparelho. So afeta testDebugUnitTest, nunca o APK.
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    implementation(project(":tauri-android"))
}
