import os
from openai import OpenAI
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Replace 'your-dashscope-api-key-here' with your actual Qwen API key
API_KEY = os.getenv("DASHSCOPE_API_KEY", "your-dashscope-api-key-here")

try:
    client = OpenAI(
        api_key=API_KEY,
        base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    )

    print("Testing connection to Qwen API...")
    
    completion = client.chat.completions.create(
        model="qwen-plus",  
        messages=[
            {'role': 'system', 'content': 'You are a helpful assistant.'},
            {'role': 'user', 'content': 'Who are you?'}
        ]
    )
    
    print("\nSuccess! Here is the response from Qwen:")
    print("-" * 40)
    print(completion.choices[0].message.content)
    print("-" * 40)
    
except Exception as e:
    print(f"\nError occurred while testing the API key:\n{e}")
    print("\nSee: https://www.alibabacloud.com/help/model-studio/developer-reference/error-code")
