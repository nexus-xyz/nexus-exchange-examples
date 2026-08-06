def markets(count: int) -> str:
    return count  # deliberate: mypy return-value error


if __name__ == "__main__":
    print(markets(3))
