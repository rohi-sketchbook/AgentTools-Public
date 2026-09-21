#include <kimodo/kimodo.hpp>

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <string>

int main(int argc, char **argv) {
    if (argc < 4 || argc > 5) {
        std::cerr << "usage: benchmark_kimodo_embedding MOTION.gguf FRAMES STEPS [REPEATS]\n";
        return 2;
    }

    const std::string model_path = argv[1];
    const unsigned frames = static_cast<unsigned>(std::stoul(argv[2]));
    const unsigned steps = static_cast<unsigned>(std::stoul(argv[3]));
    const unsigned repeats = argc == 5 ? static_cast<unsigned>(std::stoul(argv[4])) : 1U;
    if (frames == 0 || steps == 0 || repeats == 0) {
        std::cerr << "frames, steps and repeats must be > 0\n";
        return 2;
    }

    using clock = std::chrono::steady_clock;
    const auto load_start = clock::now();
    auto model = kimodo::model::load(model_path);
    const auto load_end = clock::now();
    if (!model) {
        std::cerr << model.error() << '\n';
        return 1;
    }

    std::array<float, kimodo::embedding_width> embedding{};
    for (std::size_t i = 0; i < embedding.size(); ++i) {
        embedding[i] = static_cast<float>((static_cast<int>(i % 31) - 15) * 0.001);
    }

    double total_ms = 0.0;
    double min_ms = 1.0e30;
    double max_ms = 0.0;
    unsigned joints = 0;
    for (unsigned i = 0; i < repeats; ++i) {
        const auto start = clock::now();
        auto motion = (*model)->generate_embedding(embedding, frames, steps, 42U + i, 2.0F, 2.0F);
        const auto end = clock::now();
        if (!motion) {
            std::cerr << motion.error() << '\n';
            return 1;
        }
        joints = motion->joints;
        const double ms = std::chrono::duration<double, std::milli>(end - start).count();
        total_ms += ms;
        min_ms = std::min(min_ms, ms);
        max_ms = std::max(max_ms, ms);
    }

    const double load_ms = std::chrono::duration<double, std::milli>(load_end - load_start).count();
    std::cout << std::fixed << std::setprecision(3)
              << "{\n"
              << "  \"frames\": " << frames << ",\n"
              << "  \"steps\": " << steps << ",\n"
              << "  \"repeats\": " << repeats << ",\n"
              << "  \"joints\": " << joints << ",\n"
              << "  \"load_ms\": " << load_ms << ",\n"
              << "  \"mean_generate_ms\": " << (total_ms / repeats) << ",\n"
              << "  \"min_generate_ms\": " << min_ms << ",\n"
              << "  \"max_generate_ms\": " << max_ms << "\n"
              << "}\n";
    return 0;
}
